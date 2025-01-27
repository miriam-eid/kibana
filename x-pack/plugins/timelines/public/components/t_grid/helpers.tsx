/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Filter, EsQueryConfig, Query } from '@kbn/es-query';
import { DataViewBase, FilterStateStore } from '@kbn/es-query';
import { get, isEmpty } from 'lodash/fp';
import memoizeOne from 'memoize-one';
import { elementOrChildrenHasFocus } from '../../../common/utils/accessibility';
import type { BrowserFields } from '../../../common/search_strategy/index_fields';
import {
  DataProviderType,
  EXISTS_OPERATOR,
  IS_ONE_OF_OPERATOR,
  IS_OPERATOR,
} from '../../../common/types/timeline';
import type { DataProvider, DataProvidersAnd } from '../../../common/types/timeline';
import { assertUnreachable } from '../../../common/utility_types';
import { convertToBuildEsQuery, escapeQueryValue } from '../utils/keury';
import { EVENTS_TABLE_CLASS_NAME } from './styles';
import { TableId } from '../../types';
import { ViewSelection } from './event_rendered_view/selector';

interface CombineQueries {
  config: EsQueryConfig;
  dataProviders: DataProvider[];
  indexPattern: DataViewBase;
  browserFields: BrowserFields;
  filters: Filter[];
  kqlQuery: Query;
  kqlMode: string;
}

const isNumber = (value: string | number): value is number => !isNaN(Number(value));

const convertDateFieldToQuery = (field: string, value: string | number) =>
  `${field}: ${isNumber(value) ? value : new Date(value).valueOf()}`;

const getBaseFields = memoizeOne((browserFields: BrowserFields): string[] => {
  const baseFields = get('base', browserFields);
  if (baseFields != null && baseFields.fields != null) {
    return Object.keys(baseFields.fields);
  }
  return [];
});

const getBrowserFieldPath = (field: string, browserFields: BrowserFields) => {
  const splitFields = field.split('.');
  const baseFields = getBaseFields(browserFields);
  if (baseFields.includes(field)) {
    return ['base', 'fields', field];
  }
  return [splitFields[0], 'fields', field];
};

const checkIfFieldTypeIsDate = (field: string, browserFields: BrowserFields) => {
  const pathBrowserField = getBrowserFieldPath(field, browserFields);
  const browserField = get(pathBrowserField, browserFields);
  if (browserField != null && browserField.type === 'date') {
    return true;
  }
  return false;
};

const convertNestedFieldToQuery = (
  field: string,
  value: string | number,
  browserFields: BrowserFields
) => {
  const pathBrowserField = getBrowserFieldPath(field, browserFields);
  const browserField = get(pathBrowserField, browserFields);
  const nestedPath = browserField.subType.nested.path;
  const key = field.replace(`${nestedPath}.`, '');
  return `${nestedPath}: { ${key}: ${browserField.type === 'date' ? `"${value}"` : value} }`;
};

const convertNestedFieldToExistQuery = (field: string, browserFields: BrowserFields) => {
  const pathBrowserField = getBrowserFieldPath(field, browserFields);
  const browserField = get(pathBrowserField, browserFields);
  const nestedPath = browserField.subType.nested.path;
  const key = field.replace(`${nestedPath}.`, '');
  return `${nestedPath}: { ${key}: * }`;
};

const checkIfFieldTypeIsNested = (field: string, browserFields: BrowserFields) => {
  const pathBrowserField = getBrowserFieldPath(field, browserFields);
  const browserField = get(pathBrowserField, browserFields);
  if (browserField != null && browserField.subType && browserField.subType.nested) {
    return true;
  }
  return false;
};

const buildQueryMatch = (
  dataProvider: DataProvider | DataProvidersAnd,
  browserFields: BrowserFields
) => {
  const {
    excluded,
    type,
    queryMatch: { field, operator, value },
  } = dataProvider;

  const isFieldTypeNested = checkIfFieldTypeIsNested(field, browserFields);
  const isExcluded = excluded ? 'NOT ' : '';

  switch (operator) {
    case IS_OPERATOR:
      if (!isStringOrNumberArray(value)) {
        return `${isExcluded}${
          type !== DataProviderType.template
            ? buildIsQueryMatch({ browserFields, field, isFieldTypeNested, value })
            : buildExistsQueryMatch({ browserFields, field, isFieldTypeNested })
        }`;
      } else {
        return `${isExcluded}${field} : ${JSON.stringify(value[0])}`;
      }

    case EXISTS_OPERATOR:
      return `${isExcluded}${buildExistsQueryMatch({ browserFields, field, isFieldTypeNested })}`;

    case IS_ONE_OF_OPERATOR:
      if (isStringOrNumberArray(value)) {
        return `${isExcluded}${buildIsOneOfQueryMatch({ field, value })}`;
      } else {
        return `${isExcluded}${field} : ${JSON.stringify(value)}`;
      }
    default:
      assertUnreachable(operator);
  }
};

export const buildGlobalQuery = (dataProviders: DataProvider[], browserFields: BrowserFields) =>
  dataProviders
    .reduce((queries: string[], dataProvider: DataProvider) => {
      const flatDataProviders = [dataProvider, ...dataProvider.and];
      const activeDataProviders = flatDataProviders.filter(
        (flatDataProvider) => flatDataProvider.enabled
      );

      if (!activeDataProviders.length) return queries;

      const activeDataProvidersQueries = activeDataProviders.map((activeDataProvider) =>
        buildQueryMatch(activeDataProvider, browserFields)
      );

      const activeDataProvidersQueryMatch = activeDataProvidersQueries.join(' and ');

      return [...queries, activeDataProvidersQueryMatch];
    }, [])
    .filter((queriesItem) => !isEmpty(queriesItem))
    .reduce((globalQuery: string, queryMatch: string, index: number, queries: string[]) => {
      if (queries.length <= 1) return queryMatch;

      return !index ? `(${queryMatch})` : `${globalQuery} or (${queryMatch})`;
    }, '');

export const isDataProviderEmpty = (dataProviders: DataProvider[]) => {
  return isEmpty(dataProviders) || isEmpty(dataProviders.filter((d) => d.enabled === true));
};

export const combineQueries = ({
  config,
  dataProviders,
  indexPattern,
  browserFields,
  filters = [],
  kqlQuery,
  kqlMode,
}: CombineQueries): { filterQuery: string | undefined; kqlError: Error | undefined } | null => {
  const kuery: Query = { query: '', language: kqlQuery.language };
  if (isDataProviderEmpty(dataProviders) && isEmpty(kqlQuery.query) && isEmpty(filters)) {
    return null;
  } else if (isDataProviderEmpty(dataProviders) && isEmpty(kqlQuery.query) && !isEmpty(filters)) {
    const [filterQuery, kqlError] = convertToBuildEsQuery({
      config,
      queries: [kuery],
      indexPattern,
      filters,
    });

    return {
      filterQuery,
      kqlError,
    };
  }

  const operatorKqlQuery = kqlMode === 'filter' ? 'and' : 'or';

  const postpend = (q: string) => `${!isEmpty(q) ? `(${q})` : ''}`;

  const globalQuery = buildGlobalQuery(dataProviders, browserFields); // based on Data Providers

  const querySuffix = postpend(kqlQuery.query as string); // based on Unified Search bar

  const queryPrefix = globalQuery ? `(${globalQuery})` : '';

  const queryOperator = queryPrefix && querySuffix ? operatorKqlQuery : '';

  kuery.query = `(${queryPrefix} ${queryOperator} ${querySuffix})`;

  const [filterQuery, kqlError] = convertToBuildEsQuery({
    config,
    queries: [kuery],
    indexPattern,
    filters,
  });

  return {
    filterQuery,
    kqlError,
  };
};

export const buildTimeRangeFilter = (from: string, to: string): Filter =>
  ({
    range: {
      '@timestamp': {
        gte: from,
        lt: to,
        format: 'strict_date_optional_time',
      },
    },
    meta: {
      type: 'range',
      disabled: false,
      negate: false,
      alias: null,
      key: '@timestamp',
      params: {
        gte: from,
        lt: to,
        format: 'strict_date_optional_time',
      },
    },
    $state: {
      store: FilterStateStore.APP_STATE,
    },
  } as Filter);

export const getCombinedFilterQuery = ({
  from,
  to,
  filters,
  ...combineQueriesParams
}: CombineQueries & { from: string; to: string }): string | undefined => {
  const combinedQueries = combineQueries({
    ...combineQueriesParams,
    filters: [...filters, buildTimeRangeFilter(from, to)],
  });

  return combinedQueries ? combinedQueries.filterQuery : undefined;
};

export const resolverIsShowing = (graphEventId: string | undefined): boolean =>
  graphEventId != null && graphEventId !== '';

export const EVENTS_COUNT_BUTTON_CLASS_NAME = 'local-events-count-button';

/** Returns true if the events table has focus */
export const tableHasFocus = (containerElement: HTMLElement | null): boolean =>
  elementOrChildrenHasFocus(
    containerElement?.querySelector<HTMLDivElement>(`.${EVENTS_TABLE_CLASS_NAME}`)
  );

export const isSelectableView = (timelineId: string): boolean =>
  timelineId === TableId.alertsOnAlertsPage || timelineId === TableId.alertsOnRuleDetailsPage;

export const isViewSelection = (value: unknown): value is ViewSelection =>
  value === 'gridView' || value === 'eventRenderedView';

/** always returns a valid default `ViewSelection` */
export const getDefaultViewSelection = ({
  timelineId,
  value,
}: {
  timelineId: string;
  value: unknown;
}): ViewSelection => {
  const defaultViewSelection = 'gridView';

  if (!isSelectableView(timelineId)) {
    return defaultViewSelection;
  } else {
    return isViewSelection(value) ? value : defaultViewSelection;
  }
};

/** This local storage key stores the `Grid / Event rendered view` selection */
export const ALERTS_TABLE_VIEW_SELECTION_KEY = 'securitySolution.alerts.table.view-selection';

export const buildIsQueryMatch = ({
  browserFields,
  field,
  isFieldTypeNested,
  value,
}: {
  browserFields: BrowserFields;
  field: string;
  isFieldTypeNested: boolean;
  value: string | number;
}): string => {
  if (isFieldTypeNested) {
    return convertNestedFieldToQuery(field, value, browserFields);
  } else if (checkIfFieldTypeIsDate(field, browserFields)) {
    return convertDateFieldToQuery(field, value);
  } else {
    return `${field} : ${isNumber(value) ? value : escapeQueryValue(value)}`;
  }
};

export const buildExistsQueryMatch = ({
  browserFields,
  field,
  isFieldTypeNested,
}: {
  browserFields: BrowserFields;
  field: string;
  isFieldTypeNested: boolean;
}): string => {
  return isFieldTypeNested
    ? convertNestedFieldToExistQuery(field, browserFields)
    : `${field} ${EXISTS_OPERATOR}`;
};

export const buildIsOneOfQueryMatch = ({
  field,
  value,
}: {
  field: string;
  value: Array<string | number>;
}): string => {
  const trimmedField = field.trim();
  if (value.length) {
    return `${trimmedField} : (${value
      .map((item) => (isNumber(item) ? Number(item) : `${escapeQueryValue(item.trim())}`))
      .join(' OR ')})`;
  }
  return `${trimmedField} : ''`;
};

export const isStringOrNumberArray = (value: unknown): value is Array<string | number> =>
  Array.isArray(value) &&
  (value.every((x) => typeof x === 'string') || value.every((x) => typeof x === 'number'));
