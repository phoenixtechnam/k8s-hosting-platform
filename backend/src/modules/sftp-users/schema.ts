// Re-export from shared api-contracts (single source of truth)
export { createSftpUserSchema, updateSftpUserSchema, rotateSftpPasswordSchema } from '@k8s-hosting/api-contracts';
export type { CreateSftpUserInput, UpdateSftpUserInput, RotateSftpPasswordInput } from '@k8s-hosting/api-contracts';
