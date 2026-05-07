# Vehicle Spec Enrichment

Standard capability that augments DVLA's bare-bones vehicle response
(make, model, fuel, year) with model/variant/trim/body/transmission/doors
sourced from a third-party UK vehicle data provider.

## Provider

[checkcardetails.co.uk](https://api.checkcardetails.co.uk) — UK Vehicle Data
API. The `/vehicleregistration` endpoint (~£0.02/lookup) returns the basics
for free-tier customers; the fuller `/ukvehicledata` endpoint (~£0.10/lookup,
trim/variant/transmission/doors) requires a separate "premium data" access
request and currently returns 403 until granted.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHECKCARDETAILS_API_KEY` | yes (for live data) | — | API key from checkcardetails.co.uk. Without it, the service is a no-op and `spec_source` reports `unavailable`. |
| `CHECKCARDETAILS_API_BASE` | no | `https://api.checkcardetails.co.uk/vehicledata` | Override for tests / staging. |
| `FEATURE_VEHICLE_SPEC_ENRICHMENT` | no | `true` | Set to `false` to explicitly disable enrichment. Any other value (or unset) keeps it ON. |

## Provisioning the API key (production)

1. Sign up at https://checkcardetails.co.uk and obtain an API key. For the
   premium tier (trim/variant/transmission/doors), submit a request via
   `https://api.checkcardetails.co.uk/support/premiumdatarequest`.
2. Push the key into the existing app secret in AWS Secrets Manager under
   `fuelapp/prod/app` (eu-west-2):

   ```bash
   AWS_REGION=eu-west-2 \
   aws secretsmanager get-secret-value \
     --secret-id fuelapp/prod/app \
     --query SecretString --output text > /tmp/secret.json
   jq '. + {"CHECKCARDETAILS_API_KEY":"PASTE_KEY_HERE"}' /tmp/secret.json > /tmp/secret.new.json
   AWS_REGION=eu-west-2 \
   aws secretsmanager put-secret-value \
     --secret-id fuelapp/prod/app \
     --secret-string file:///tmp/secret.new.json
   shred -u /tmp/secret.json /tmp/secret.new.json
   ```

3. Add the secret reference to the `fueluk-prod-api` task definition and
   register a new revision. The `FEATURE_VEHICLE_SPEC_ENRICHMENT` env var
   no longer needs to be set — it defaults to ON.

   ```bash
   AWS_REGION=eu-west-2 \
   aws ecs describe-task-definition --task-definition fueluk-prod-api \
     --query 'taskDefinition' > /tmp/td.json
   jq '
     .containerDefinitions[0].secrets += [{
       "name":"CHECKCARDETAILS_API_KEY",
       "valueFrom":"arn:aws:secretsmanager:eu-west-2:<ACCOUNT_ID>:secret:fuelapp/prod/app:CHECKCARDETAILS_API_KEY::"
     }]
     | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,
           .compatibilities,.registeredAt,.registeredBy)
   ' /tmp/td.json > /tmp/td.new.json
   AWS_REGION=eu-west-2 \
   aws ecs register-task-definition --cli-input-json file:///tmp/td.new.json
   AWS_REGION=eu-west-2 \
   aws ecs update-service \
     --cluster fuelapp-prod-cluster \
     --service fueluk-prod-service \
     --task-definition fueluk-prod-api \
     --force-new-deployment
   ```

## Verifying enrichment is live

Hit the diagnostics endpoint:

```bash
curl https://api.freefuelprice.app/api/v1/diagnostics | jq .vehicle_spec
```

Expected fields:

```json
{
  "provider": "checkcardetails",
  "flag_enabled": true,
  "key_present": true,
  "last_24h_calls": 17,
  "last_24h_errors": 0,
  "premium_tier_authorised": true
}
```

- `key_present: true` confirms the secret reached the running container.
- `last_24h_calls > 0` after a vehicle lookup confirms the upstream is
  actually being called.
- `premium_tier_authorised` is `true` once any response in the last 24h
  came back with a non-null `trim` — i.e. the £0.10 tier is authorised.

You can also verify against a known plate (e.g. NJ69DDF):

```bash
curl 'https://api.freefuelprice.app/api/v1/vehicles/lookup?reg=NJ69DDF' \
  | jq '{trim, variant, transmission, doors, body_style, model_full, spec_source}'
```

When premium is authorised you'll see populated values and
`spec_source: "checkcardetails"`. When it isn't, the keys remain present
but null, with `spec_source: "unavailable"`.

## Response schema

`GET /api/v1/vehicles/lookup` always returns the following keys, regardless
of upstream availability:

| Key | Type | Source |
|---|---|---|
| `trim` | string\|null | checkcardetails |
| `variant` | string\|null | checkcardetails |
| `transmission` | string\|null | checkcardetails |
| `doors` | int\|null | checkcardetails |
| `body_style` | string\|null | checkcardetails |
| `engine_capacity_cc` | int\|null | DVLA (fallback always populated when DVLA has it) |
| `fuel_type_detailed` | string\|null | checkcardetails |
| `model_full` | string\|null | checkcardetails (derivative \| variant \| model) |
| `spec_source` | `"checkcardetails"` \| `"dvla_only"` \| `"unavailable"` | derived |

`spec_source` interpretation:

- `checkcardetails` — enrichment fired and returned data.
- `dvla_only` — feature flag explicitly disabled; only DVLA fields populated.
- `unavailable` — feature flag on but upstream returned no data (key
  missing, 403 premium not authorised, 404, error, timeout, etc.).

## Caching

- Positive cache: 30 days per registration (in-memory LRU, max 5000 entries).
- Negative cache: 24h on `403` (premium tier not yet authorised) and `404`
  (registration unknown) so we don't hammer the upstream while access is
  being granted.
- 5xx and timeouts are NOT negative-cached — those are treated as transient.

## Rollback

Set `FEATURE_VEHICLE_SPEC_ENRICHMENT=false` in the task definition and
redeploy. The response schema stays stable; only `spec_source` flips to
`dvla_only` and the spec keys go null.
