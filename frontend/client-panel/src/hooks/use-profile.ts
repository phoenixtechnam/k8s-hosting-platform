import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface UpdateProfileInput {
  readonly full_name?: string;
  readonly email?: string;
}

interface ProfileResponse {
  readonly data: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly role: string;
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
