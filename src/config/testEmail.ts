import { devNull } from 'node:os';
import { isTestExecution } from './testDatabase.js';

/** Also recognizes node --test when a case temporarily changes NODE_ENV. */
export const testEmailMode = () => isTestExecution(process.env);
export function assertRealEmailAllowed() {
  if (testEmailMode()) throw new Error('Real email transport disabled in automated tests');
}
/** Only synthetic values; never read or edit a developer's credential files. */
export function isolateTestAwsEnvironment(env: NodeJS.ProcessEnv) {
  // Keep keys present (empty) so a later dotenv load cannot restore their values.
  for (const name of Object.keys(env)) if (name.startsWith('AWS_')) env[name] = '';
  Object.assign(env, {
    AWS_ACCESS_KEY_ID: 'test-no-send-access-key',
    AWS_SECRET_ACCESS_KEY: 'test-no-send-secret-key',
    AWS_SESSION_TOKEN: 'test-no-send-session-token',
    AWS_REGION: 'eu-west-2', AWS_DEFAULT_REGION: 'eu-west-2',
    AWS_PROFILE: '', AWS_DEFAULT_PROFILE: '', AWS_SDK_LOAD_CONFIG: '0',
    AWS_SHARED_CREDENTIALS_FILE: devNull, AWS_CONFIG_FILE: devNull,
    AWS_EC2_METADATA_DISABLED: 'true', AWS_EC2_METADATA_SERVICE_ENDPOINT: '',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: '', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: '', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: devNull,
    AWS_WEB_IDENTITY_TOKEN_FILE: devNull, AWS_ROLE_ARN: '', AWS_ROLE_SESSION_NAME: '',
  });
}
