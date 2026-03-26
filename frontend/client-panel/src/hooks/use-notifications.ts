interface NotificationsResult {
  readonly data: readonly never[];
  readonly isLoading: false;
  readonly isError: false;
}

export function useNotifications(): NotificationsResult {
  return { data: [], isLoading: false, isError: false };
}
