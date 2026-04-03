// Re-export from shared api-contracts (single source of truth)
export {
  createDeploymentSchema,
  updateDeploymentSchema,
  updateDeploymentResourcesSchema,
  type CreateDeploymentInput,
  type UpdateDeploymentInput,
  type UpdateDeploymentResourcesInput,
  type DeploymentResponse,
} from '@k8s-hosting/api-contracts';
