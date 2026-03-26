// Re-export from shared contracts — single source of truth
export {
  loginSchema,
  changePasswordSchema,
  updateProfileSchema,
  type LoginInput,
  type ChangePasswordInput,
  type UpdateProfileInput,
} from '@k8s-hosting/api-contracts';
