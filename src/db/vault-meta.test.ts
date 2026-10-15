import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { assertVaultSchemaCompatible, readVaultMeta, recordVaultSchema, VaultSchemaTooNewError } from './vault-meta';

test('a vault from a newer schema is refused before migrations run', () => {
  const database = new Database(':memory:');
  assertVaultSchemaCompatible(database, 4, 1);
  recordVaultSchema(database, 1, '1.0.0');
  expect(readVaultMeta(database)).toMatchObject({ schema_generation: '1', last_app_version: '1.0.0', first_guarded_app_version: '1.0.0' });
  recordVaultSchema(database, 3, '2.0.0');
  expect(() => assertVaultSchemaCompatible(database, 4, 1)).toThrow(VaultSchemaTooNewError);
  expect(() => assertVaultSchemaCompatible(database, 4, 1)).toThrow('2.0.0');
  // A newer build reopening never lowers the generation.
  recordVaultSchema(database, 1, '1.0.1');
  expect(readVaultMeta(database).schema_generation).toBe('3');
});

test('a newer core user_version is refused too', () => {
  const database = new Database(':memory:');
  database.exec('PRAGMA user_version = 9');
  expect(() => assertVaultSchemaCompatible(database, 4, 1)).toThrow('was not opened or modified');
});
