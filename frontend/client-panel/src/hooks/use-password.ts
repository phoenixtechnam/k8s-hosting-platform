import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface ChangePasswordInput {
  readonly current_password: string;
  readonly new_password: string;
}

interface ChangePasswordResponse {
  readonly data: { readonly message: string };
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      apiFetch<ChangePasswordResponse>('/api/v1/auth/password', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  });
}
