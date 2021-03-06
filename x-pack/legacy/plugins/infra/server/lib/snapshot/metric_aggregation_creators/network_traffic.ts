/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { InfraNodeType } from '../../../graphql/types';
import { rate } from './rate';

interface MetricFields {
  [InfraNodeType.container]: string;
  [InfraNodeType.pod]: string;
  [InfraNodeType.host]: string;
}

interface InterfaceFields {
  [InfraNodeType.container]: string;
  [InfraNodeType.pod]: null;
  [InfraNodeType.host]: string;
}

export const networkTraffic = (
  id: string,
  metricFields: MetricFields,
  interfaceFields: InterfaceFields
) => {
  const rateAggregations = rate(id, metricFields);
  return (nodeType: InfraNodeType) => {
    // Metricbeat doesn't collect interface data for Kubernetes Pods,
    // for these we'll use a standard rate calculation.
    if (nodeType === InfraNodeType.pod) {
      return rateAggregations(nodeType);
    }
    const metricField = metricFields[nodeType];
    const interfaceField = interfaceFields[nodeType];

    if (metricField && interfaceField) {
      return {
        [`${id}_interfaces`]: {
          terms: { field: interfaceField },
          aggregations: {
            [`${id}_interface_avg`]: { avg: { field: metricField } },
          },
        },
        [`${id}_sum_of_interfaces`]: {
          sum_bucket: {
            buckets_path: `${id}_interfaces>${id}_interface_avg`,
          },
        },
        [`${id}_deriv`]: {
          derivative: {
            buckets_path: `${id}_sum_of_interfaces`,
            gap_policy: 'skip',
            unit: '1s',
          },
        },
        [id]: {
          bucket_script: {
            buckets_path: { value: `${id}_deriv[normalized_value]` },
            script: {
              source: 'params.value > 0.0 ? params.value : 0.0',
              lang: 'painless',
            },
            gap_policy: 'skip',
          },
        },
      };
    }
  };
};
