// Re-export from shared api-contracts (single source of truth)
export {
  createCatalogRepoSchema,
  updateCatalogRepoSchema,
  type CreateCatalogRepoInput,
  type UpdateCatalogRepoInput,
  type CatalogEntryResponse,
  type CatalogRepoResponse,
  type CatalogEntryVersionResponse,
} from '@k8s-hosting/api-contracts';
