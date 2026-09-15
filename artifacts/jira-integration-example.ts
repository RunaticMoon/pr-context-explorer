import {
  JiraCloudAdapter, JiraDataCenterAdapter, discoverJiraCandidates, captureJiraCandidates,
  type JiraConnection, type DiscoveryInput, type DiscoveryConfig, type JiraCaptureOptions,
} from '../src/server/jira/index.ts';

/** Compilable server-side integration example. Nothing executes on import. */
export async function buildJiraContext(
  input: DiscoveryInput,
  connections: readonly JiraConnection[],
  projectHosts: DiscoveryConfig['projectHosts'],
  projectKeyPattern?: string,
  options: JiraCaptureOptions = {},
) {
  const adapters = connections.map(connection => connection.deployment === 'cloud'
    ? new JiraCloudAdapter(connection) : new JiraDataCenterAdapter(connection));
  const discovery = discoverJiraCandidates(input, {
    sites: adapters.map(adapter => adapter.site), projectHosts, projectKeyPattern,
  });
  const capture = await captureJiraCandidates(discovery.candidates, adapters, options);
  // Keep original source text as well as per-occurrence pointers.
  // Core may feed captured snapshots + explicit coverage into its ContextBundle.
  // No adapter, credential callback or environment value goes to browser/model.
  return { discovery, capture };
}
