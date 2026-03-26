// Re-export from shared api-contracts (single source of truth)
export {
  createProtectedDirectorySchema,
  updateProtectedDirectorySchema,
  createProtectedDirectoryUserSchema,
  changeProtectedDirectoryUserPasswordSchema,
  type CreateProtectedDirectoryInput,
  type UpdateProtectedDirectoryInput,
  type CreateProtectedDirectoryUserInput,
} from '@k8s-hosting/api-contracts';
