import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface UpdateProfileInput {
  readonly full_name?: string;
  readonly email?: string;
  readonly timezone?: string | null;
}

interface ProfileResponse {
  readonly data: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly role: string;
    readonly timezone?: string | null;
  };
}

export function useUpdateProfile() {
  return useMutation({
    mutationFn: (input: UpdateProfileInput) =>
      apiFetch<ProfileResponse>('/api/v1/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  });
}
