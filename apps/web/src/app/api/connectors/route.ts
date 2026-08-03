import { listConnectorManifests } from '@byok-grid/connectors';

export function GET() {
  return Response.json(
    { connectors: listConnectorManifests() },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}
