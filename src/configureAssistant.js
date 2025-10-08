import 'dotenv/config';
import { VapiClient, VapiError } from '@vapi-ai/server-sdk';
import assistantConfig from './assistantConfig.js';

const args = process.argv.slice(2);

const getArgValue = (flag) => {
  const prefix = `${flag}=`;
  const exactIndex = args.indexOf(flag);

  if (exactIndex !== -1) {
    const maybeValue = args[exactIndex + 1];
    if (!maybeValue || maybeValue.startsWith('--')) {
      return '';
    }
    return maybeValue;
  }

  const withEquals = args.find((arg) => arg.startsWith(prefix));
  return withEquals ? withEquals.slice(prefix.length) : undefined;
};

const assistantId = getArgValue('--assistant-id') || process.env.ASSISTANT_ID || undefined;
const dryRun = args.includes('--dry-run') || args.includes('--preview');

const token = process.env.VAPI_API_KEY;

const warnIfPlaceholders = () => {
  const tools = assistantConfig?.model?.tools ?? [];
  const placeholderUrls = tools
    .filter((tool) => tool.type === 'apiRequest' && typeof tool.url === 'string')
    .map((tool) => tool.url)
    .filter((url) => url.includes('example.com'));

  if (placeholderUrls.length > 0) {
    console.warn('⚠️  Replace placeholder API URLs before using this in production:', placeholderUrls);
  }
};

const printPreview = () => {
  console.log('Previewing assistant configuration (no API changes were made):');
  console.dir(assistantConfig, { depth: null, colors: true });
};

const main = async () => {
  warnIfPlaceholders();

  if (dryRun) {
    printPreview();
    return;
  }

  if (!token) {
    console.error('Missing VAPI_API_KEY. Add it to your environment or .env file before running this script.');
    process.exit(1);
  }

  const client = new VapiClient({ token });

  try {
    if (assistantId) {
      const updated = await client.assistants.update(assistantId, assistantConfig);
      console.log(`Assistant ${updated.id} updated with the latest configuration.`);
      console.log('Name:', updated.name);
    } else {
      const created = await client.assistants.create(assistantConfig);
      console.log(`Assistant ${created.id} created.`);
      console.log('Name:', created.name);
    }
  } catch (error) {
    if (error instanceof VapiError) {
      console.error('Vapi API error:', error.statusCode, error.message);
      if (error.body) {
        console.error('Details:', JSON.stringify(error.body, null, 2));
      }
    } else {
      console.error('Unexpected error:', error);
    }
    process.exitCode = 1;
  }
};

main();
