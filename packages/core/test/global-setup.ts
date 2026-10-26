import { ensureAssets } from '@lumen/fake-portal';

export default async function setup(): Promise<void> {
  await ensureAssets();
}
