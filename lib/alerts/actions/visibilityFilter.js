// @flow

import {createAction, type ActionType} from 'redux-actions'

import {createVoidPayloadAction} from '../../common/actions'

export const setAlertAgencyFilter = createAction(
  'SET_ALERT_AGENCY_FILTER',
  (payload: string) => payload
)
export const setAlertSort = createAction(
  'SET_ALERT_SORT',
  (payload: {
    direction: string,
    type: string
  }) => payload
)
export const setVisibilityFilter = createVoidPayloadAction('SET_ALERT_VISIBILITY_FILTER')
export const setVisibilitySearchText = createAction(
  'SET_ALERT_VISIBILITY_SEARCH_TEXT',
  (payload: string) => payload
)

export type AlertVisibilityFilterActions = ActionType<typeof setAlertAgencyFilter> |
  ActionType<typeof setAlertSort> |
  ActionType<typeof setVisibilityFilter> |
  ActionType<typeof setVisibilitySearchText>
