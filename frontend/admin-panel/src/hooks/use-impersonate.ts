import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface ImpersonateResponse {
  readonly token: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly role: string;
    readonly panel: string;
    readonly clientId: string;
  };
  readonly impersonatedBy: string;
  readonly expiresIn: number;
}

export function useImpersonate() {
  return useMutation({
    mutationFn: (clientId: string) =>
      apiFetch<{ data: ImpersonateResponse }>(`/api/v1/admin/impersonate/${clientId}`, {
        method: 'POST',
      }),
  });
}
