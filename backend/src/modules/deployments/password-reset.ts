/**
 * Password-reset init container builder.
 *
 * When re-deploying into a pre-existing PVC folder, the database engine
 * ignores MARIADB_ROOT_PASSWORD / MYSQL_ROOT_PASSWORD / POSTGRES_PASSWORD
 * because the data directory already exists. This module builds an init
 * container that resets the root password before the main container starts.
 */

interface PasswordResetInput {
  readonly catalogCode: string;
  readonly image: string;
  readonly storagePath: string;
  readonly volumeMountName: string;
  readonly passwordEnvVar: string;
  readonly passwordEnvVarUser?: string;
}

interface InitContainer {
  readonly name: string;
  readonly image: string;
  readonly command: readonly string[];
  readonly volumeMounts: readonly { name: string; mountPath: string; subPath?: string }[];
  readonly resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  readonly securityContext?: Record<string, unknown>;
}

const DB_ENGINES: Record<string, 'mariadb' | 'mysql' | 'postgresql' | 'mongodb'> = {
  mariadb: 'mariadb',
  mysql: 'mysql',
  postgresql: 'postgresql',
  'mongodb-7': 'mongodb',
  mongodb: 'mongodb',
};

const INIT_RESOURCES = {
  requests: { cpu: '50m', memory: '128Mi' },
  limits: { cpu: '200m', memory: '512Mi' },
};

function buildMariadbResetScript(passwordEnvVar: string): string {
  return [
    'set -e',
    'DATADIR=/var/lib/mysql',
    'if [ ! -d "$DATADIR/mysql" ]; then echo "No existing data, skipping password reset"; exit 0; fi',
    '# Start with --skip-grant-tables so we can connect without the old password',
    'mariadbd --user=mysql --datadir="$DATADIR" --skip-networking --skip-grant-tables &',
    'PID=$!',
    'for i in $(seq 1 60); do if mariadb -u root --socket=/run/mysqld/mysqld.sock -e "SELECT 1" 2>/dev/null; then break; fi; sleep 1; done',
    '# Re-enable grant tables and reset password',
    `mariadb -u root --socket=/run/mysqld/mysqld.sock -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '\${${passwordEnvVar}}'; ALTER USER 'root'@'%' IDENTIFIED BY '\${${passwordEnvVar}}';"`,
    `mariadb-admin -u root --password="\${${passwordEnvVar}}" --socket=/run/mysqld/mysqld.sock shutdown 2>/dev/null || kill $PID`,
    'wait $PID 2>/dev/null || true',
    'echo "Root password reset complete"',
  ].join('\n');
}

function buildMysqlResetScript(passwordEnvVar: string): string {
  return [
    'set -e',
    'DATADIR=/var/lib/mysql',
    'if [ ! -d "$DATADIR/mysql" ]; then echo "No existing data, skipping password reset"; exit 0; fi',
    '# Start with --skip-grant-tables so we can connect without the old password',
    'mysqld --user=mysql --datadir="$DATADIR" --skip-networking --skip-grant-tables &',
    'PID=$!',
    'for i in $(seq 1 60); do if mysqladmin ping --socket=/var/run/mysqld/mysqld.sock 2>/dev/null; then break; fi; sleep 1; done',
    '# Re-enable grant tables and reset password',
    `mysql -u root --socket=/var/run/mysqld/mysqld.sock -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '\${${passwordEnvVar}}'; ALTER USER 'root'@'%' IDENTIFIED BY '\${${passwordEnvVar}}';"`,
    `mysqladmin -u root --password="\${${passwordEnvVar}}" --socket=/var/run/mysqld/mysqld.sock shutdown 2>/dev/null || kill $PID`,
    'wait $PID 2>/dev/null || true',
    'echo "Root password reset complete"',
  ].join('\n');
}

function buildPostgresqlResetScript(passwordEnvVar: string): string {
  // PostgreSQL 18 uses /var/lib/postgresql/<major>/docker as PGDATA.
  // We detect the actual PGDATA by finding PG_VERSION in any subdirectory.
  return [
    'set -e',
    'MOUNT=/var/lib/postgresql',
    '# Find PGDATA — could be /var/lib/postgresql/data (17) or /var/lib/postgresql/18/docker (18+)',
    'PGDATA=""',
    'for candidate in "$MOUNT"/*/docker "$MOUNT/data"; do',
    '  if [ -s "$candidate/PG_VERSION" ]; then PGDATA="$candidate"; break; fi',
    'done',
    'if [ -z "$PGDATA" ]; then echo "No existing data (PG_VERSION not found), skipping password reset"; exit 0; fi',
    'export PGDATA',
    'echo "Detected PGDATA=$PGDATA"',
    '# Backup pg_hba.conf',
    'cp "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.conf.bak"',
    '# Temporarily allow trust auth for local connections',
    'printf "local all all trust\\nhost all all 127.0.0.1/32 trust\\nhost all all ::1/128 trust\\n" > "$PGDATA/pg_hba.conf"',
    '# Start postgres locally',
    'pg_ctl -D "$PGDATA" -o "-c listen_addresses=\'\'" -w start',
    `psql -U postgres -c "ALTER USER postgres PASSWORD '\${${passwordEnvVar}}';"`,
    '# Stop and restore pg_hba.conf',
    'pg_ctl -D "$PGDATA" -m fast -w stop',
    'mv "$PGDATA/pg_hba.conf.bak" "$PGDATA/pg_hba.conf"',
    'echo "Postgres password reset complete"',
  ].join('\n');
}

function buildMongodbResetScript(passwordEnvVar: string, userEnvVar: string): string {
  return [
    'set -e',
    'DBPATH=/data/db',
    'if [ ! -e "$DBPATH/WiredTiger" ]; then echo "No existing data, skipping password reset"; exit 0; fi',
    '# Start mongod without auth',
    'mongod --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port 27017 --logpath /tmp/mongod.log --fork',
    'for i in $(seq 1 60); do if mongosh --host 127.0.0.1 --port 27017 --quiet --eval "db.adminCommand(\'ping\')" 2>/dev/null; then break; fi; sleep 1; done',
    `mongosh --host 127.0.0.1 --port 27017 --quiet --eval "db.getSiblingDB('admin').changeUserPassword('\${${userEnvVar}}', '\${${passwordEnvVar}}')"`,
    'mongod --dbpath "$DBPATH" --shutdown',
    'echo "MongoDB password reset complete"',
  ].join('\n');
}

export function buildPasswordResetInitContainer(input: PasswordResetInput): InitContainer | null {
  const { catalogCode, image, storagePath, volumeMountName, passwordEnvVar, passwordEnvVarUser } = input;

  if (!passwordEnvVar) return null;

  const engine = DB_ENGINES[catalogCode];
  if (!engine) return null;

  let script: string;
  let mountPath: string;
  let securityContext: Record<string, unknown> | undefined;

  switch (engine) {
    case 'mariadb':
      script = buildMariadbResetScript(passwordEnvVar);
      mountPath = '/var/lib/mysql';
      break;
    case 'mysql':
      script = buildMysqlResetScript(passwordEnvVar);
      mountPath = '/var/lib/mysql';
      break;
    case 'postgresql':
      script = buildPostgresqlResetScript(passwordEnvVar);
      mountPath = '/var/lib/postgresql';
      // PostgreSQL requires running as the postgres user (UID 999 in official image)
      securityContext = { runAsUser: 999 };
      break;
    case 'mongodb':
      script = buildMongodbResetScript(passwordEnvVar, passwordEnvVarUser ?? 'root');
      mountPath = '/data/db';
      break;
    default:
      return null;
  }

  return {
    name: 'reset-root-password',
    image,
    command: ['sh', '-c', script],
    volumeMounts: [
      { name: volumeMountName, mountPath, subPath: storagePath },
    ],
    resources: INIT_RESOURCES,
    ...(securityContext ? { securityContext } : {}),
  };
}
