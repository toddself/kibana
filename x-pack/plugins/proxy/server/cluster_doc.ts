/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Boom from 'boom';
import { v4 } from 'uuid';
import { Observable, Subscription, pairs } from 'rxjs';
import { first } from 'rxjs/operators';

import {
  PluginInitializerContext,
  Logger,
  ClusterClient,
  ElasticsearchServiceSetup,
} from 'src/core/server';

import { ProxyPluginType } from './proxy';

export enum RouteState {
  Initializing,
  Started,
  Closed,
}

export interface RoutingNode {
  type: string; // what are all the types this can be?
  node: string;
  state: RouteState;
}

interface LivenessNode {
  lastUpdate: number;
}

interface ClusterDoc {
  nodes: NodeList;
  routing_table: RoutingTable;
}

export interface RoutingTable {
  [key: string]: RoutingNode;
}

interface NodeList {
  [key: string]: LivenessNode;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (min - max) + min);
}

export class ClusterDocClient {
  public nodeName: string;
  public validState: boolean = true;
  private readonly updateFloor = 30 * 1000; // 30 seconds is the fastest you can update
  private routingTable: RoutingTable = {};
  private elasticsearch?: Observable<ClusterClient>;
  private updateInterval? = this.updateFloor;
  private timeoutThreshold = 15 * 1000;
  private timer: null | number = null;
  private configSubscription?: Subscription;
  private seq_no = 0;
  private primary_term = 0;

  private readonly minUpdateShuffle = 0;
  private readonly maxUpdateShuffle = 1000;
  private readonly proxyIndex = '.kibana';
  private readonly proxyDoc = 'proxy-resource-list';
  private readonly log: Logger;
  private readonly config$: Observable<ProxyPluginType>;

  constructor(initializerContext: PluginInitializerContext) {
    this.nodeName = v4();
    this.config$ = initializerContext.config.create<ProxyPluginType>();
    this.log = initializerContext.logger.get('proxy');
  }

  public async setup(esClient: Partial<ElasticsearchServiceSetup>) {
    this.elasticsearch = esClient.dataClient$;
    this.configSubscription = this.config$.subscribe(config => {
      this.setConfig(config);
    });
    const config = await this.config$.pipe(first()).toPromise();
    this.setConfig(config);
  }

  public async start() {
    return await this.mainLoop();
  }

  public async stop() {
    // stop http service
    if (this.timer) {
      clearTimeout(this.timer);
    }

    const nodes = await this.getNodeList();
    delete nodes[this.nodeName];
    await this.updateNodeList(nodes);

    if (this.configSubscription === undefined) {
      return;
    }

    this.configSubscription.unsubscribe();
    this.configSubscription = undefined;
  }

  public getRoutingTable(): Observable<[string, RoutingNode]> {
    return pairs(this.routingTable);
  }

  public getNodeForResource(resource: string) {
    return this.routingTable[resource];
  }

  public async assignResource(resource: string, type: string, state: RouteState, node?: string) {
    // getting the ndoe list will refresh the internal routing table to match
    // whatever the es doc contains, so this needs to be done before we assign
    // the new node to the routing table, or we lose the update
    if (!this.validState) {
      this.log.error('The proxy is not in a valid state, you may not assign resources');
      throw new Error('Unable to assign resource because proxy is in an invalid state');
    }
    const nodes = await this.getNodeList();
    if (this.routingTable[resource]) {
      throw new Error(`${resource} already exists on ${this.routingTable[resource].node}`);
    }
    const data = {
      type,
      state,
      node: node || this.nodeName,
    };
    this.routingTable[resource] = data;
    const currentTime = new Date().getTime();
    await this.updateNodeList(this.updateLocalNode(nodes, currentTime));
  }

  public async unassignResource(resource: string) {
    if (!this.validState) {
      this.log.error('The proxy is not in a valid state, you may not unassign resources');
      throw new Error('Unable to unassign resource because proxy is in an invalid state');
    }
    const nodes = await this.getNodeList();
    delete this.routingTable[resource];
    const currentTime = new Date().getTime();
    await this.updateNodeList(this.updateLocalNode(nodes, currentTime));
  }

  private setConfig(config: ProxyPluginType) {
    let update = randomInt(this.minUpdateShuffle, this.maxUpdateShuffle);
    if (config.updateInterval < this.updateFloor) {
      update += this.updateFloor;
    } else {
      update += this.updateFloor;
    }

    let timeout = config.timeoutThreshold;
    if (timeout < update) {
      timeout = update + randomInt(this.minUpdateShuffle, this.maxUpdateShuffle);
    }
    this.updateInterval = update;
    this.timeoutThreshold = timeout;
  }

  private setTimer() {
    if (this.timer) return;
    this.log.debug('Set timer to updateNodeMap');
    this.timer = setTimeout(async () => {
      this.log.debug('Updating node map');
      await this.mainLoop();
    }, this.updateInterval);
  }

  private updateRoutingTable(routingTable: RoutingTable): void {
    const currentRoutes = [...Object.keys(this.routingTable)];
    for (const [key, node] of Object.entries(routingTable)) {
      this.routingTable[key] = node;
      const idx = currentRoutes.findIndex(k => k === key);
      if (idx) currentRoutes.splice(idx, 1);
    }

    for (const key of currentRoutes.values()) {
      delete this.routingTable[key];
    }
  }

  private async getNodeList(): Promise<NodeList> {
    if (!this.elasticsearch) {
      const err = Boom.boomify(new Error('You must call setup first'), { statusCode: 412 });
      throw err;
    }
    const client = await this.elasticsearch.pipe(first()).toPromise();
    const params = {
      id: this.proxyDoc,
      index: this.proxyIndex,
      _source: true,
    };
    const reply = await client.callAsInternalUser('get', params);
    this.seq_no = reply._seq_no;
    this.primary_term = reply._primary_term;
    const data: ClusterDoc = reply._source;
    this.updateRoutingTable(data.routing_table || {});
    const nodes: NodeList = data.nodes || {};
    return nodes;
  }

  private async updateNodeList(nodes: NodeList): Promise<void> {
    if (!this.elasticsearch) {
      const err = Boom.boomify(new Error('You must call setup first'), { statusCode: 412 });
      throw err;
    }
    const doc = {
      nodes,
      routing_table: this.routingTable,
    };
    const client = await this.elasticsearch.pipe(first()).toPromise();
    const params = {
      id: this.proxyDoc,
      index: this.proxyIndex,
      if_seq_no: this.seq_no,
      if_primary_term: this.primary_term,
      body: doc,
    };
    await client.callAsInternalUser('index', params);
  }

  private updateLocalNode(nodes: NodeList, finishTime: number): NodeList {
    nodes[this.nodeName] = {
      lastUpdate: finishTime,
    };
    return nodes;
  }

  private removeNode(node: string) {
    for (const [resource, data] of Object.entries(this.routingTable)) {
      if (data.node === node) {
        delete this.routingTable[resource];
      }
    }
  }

  private async mainLoop(): Promise<void> {
    let nodes = {} as NodeList;
    try {
      nodes = await this.getNodeList();
      this.validState = true;
    } catch (err) {
      this.log.error(
        'Unable to read or parse proxy document. Proxy will be disabled until this succeeds'
      );
      this.validState = false;
      this.setTimer();
      return;
    }

    const finishTime = new Date().getTime();
    if (this.validState) {
      for (const [key, node] of Object.entries(nodes)) {
        const timeout = finishTime - node.lastUpdate;
        if (!node || timeout > this.timeoutThreshold) {
          this.log.warn(`Node ${key} has not updated in ${timeout}ms and has been dropped`);
          this.removeNode(key);
          delete nodes[key];
        }
      }
    }

    try {
      await this.updateNodeList(this.updateLocalNode(nodes, finishTime));
      this.validState = true;
    } catch (err) {
      if (err.output.statusCode === 409) {
        this.log.error('Could not update document. Proxy state might be out of sync', err);
      } else {
        this.log.error(
          'Invalid response from elasticsearch, or issue with local state. Proxy state will be disabled until this succeeds',
          err
        );
        this.validState = false;
      }
    } finally {
      this.setTimer();
    }
  }
}
