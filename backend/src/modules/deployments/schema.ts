// Re-export from shared api-contracts (single source of truth)
export {
  createDeploymentSchema,
  updateDeploymentSchema,
  type CreateDeploymentInput,
  type UpdateDeploymentInput,
  type DeploymentResponse,
} from '@k8s-hosting/api-contracts';
