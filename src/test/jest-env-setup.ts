// Jest setupFiles entry (see package.json's jest config) — loads the same
// .env dotenv file main.ts loads for a normal dev boot, so services that
// intentionally fail loudly on a missing required env var (e.g.
// CredentialEncryptionService and CREDENTIAL_ENC_KEY — see
// device-control/crypto/credential-encryption.service.ts) don't break
// every test suite that constructs the full AppModule. Does not weaken
// that invariant in production: main.ts still refuses to boot without a
// real CREDENTIAL_ENC_KEY set in the actual deployment environment, this
// only affects the local `.env` used for `npm test`.
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
