# Rayfin Fabricator analytics queries

These queries run in Azure Portal → the `rayfin-fabricator-insights` Application Insights resource (or the `rayfin-fabricator-logs` Log Analytics workspace) → **Logs** blade. Paste one query from `queries.kql`, then select **Run**. The Logs time-range picker applies to queries without their own `timestamp` filter; queries that include filters such as `timestamp > ago(30d)` use the query's filter and effectively override the picker for that result.

## Query map

| Business question | Query name in `queries.kql` |
| --- | --- |
| How many users tried it? | Total distinct users who TRIED |
| How many tenants tried it? | Total distinct TENANTS who tried |
| How many users deployed an app? | Total distinct users who DEPLOYED |
| How many tenants deployed an app? | Total distinct tenants who deployed |
| MAU/DAU/WAU? | DAU (daily active users, last 30 days); WAU (rolling 7-day distinct users per day, last 90 days); MAU (rolling 30-day distinct users per day, last 90 days); MAU/DAU stickiness ratio (latest period) |
| What's my tried→deployed conversion? | Tried -> Deployed conversion (users); Funnel summary |

## Schema notes

Telemetry lands in the Application Insights `customEvents` table. The app sends `signin` events for product activity and `deploy` events for deploy attempts. User identity is pseudonymous: `user_Id` is a SHA-256 hash of the user's email, while `tostring(customDimensions.tenantDomain)` is the raw sign-in domain (e.g. `contoso.com`). No raw emails are queried here.

Kusto `dcount()` uses an approximate HyperLogLog distinct count. For higher accuracy on small sets, use the higher-accuracy form, for example `dcount(user_Id, 4)` or `dcount(tostring(customDimensions.tenantDomain), 4)`.

Free-tier Application Insights / Log Analytics data retention is commonly about 31 days by default. The "all time" queries are therefore bounded by the workspace retention period, not by the app's lifetime.
