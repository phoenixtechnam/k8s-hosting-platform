ALTER TABLE `clients`
  ADD COLUMN `cpu_limit_override` DECIMAL(5, 2) NULL DEFAULT NULL,
  ADD COLUMN `memory_limit_override` DECIMAL(5, 2) NULL DEFAULT NULL,
  ADD COLUMN `storage_limit_override` DECIMAL(10, 2) NULL DEFAULT NULL,
  ADD COLUMN `max_sub_users_override` INT NULL DEFAULT NULL,
  ADD COLUMN `monthly_price_override` DECIMAL(10, 2) NULL DEFAULT NULL;
