# pi-orch

Persistent worker orchestration for [Pi](https://pi.dev).

Pi keeps its normal coding tools while gaining asynchronous workers with persistent session history, steering, model hierarchy, and review handoffs.

## Install

```bash
pi install npm:pi-orch
```

Alternatively, install from GitHub:

```bash
pi install git:github.com/hetsaraiya/pi-orch
```

For local development:

```bash
pi install /absolute/path/to/pi-orch
```

Then restart Pi or run `/reload`.

## Usage

- `/orch-settings` — activate/deactivate orchestration and select parent/worker models.
- `/workers` — show worker status.
- `@worker-id feedback` — steer a specific worker while preserving its history.

When active, Pi prefers delegation but retains all normal tools and may work directly when explicitly requested or when direct work is more appropriate. When deactivated, only pi-orch behavior and worker tools are disabled.

## Configuration

Settings are saved per project in `.pi/pi-orch.json`:

```json
{
  "active": true,
  "orchestratorModel": "anthropic/claude-sonnet-4-5",
  "workerModel": "anthropic/claude-haiku-4-5",
  "maxWorkers": 4
}
```

The model picker uses Pi's scoped models from `--models`, saved `enabledModels`, or an optional `modelScope` array. Omitting `workerModel` makes workers inherit the active parent model.

## Notes

Workers share the current working tree. Assign non-overlapping scopes when running workers concurrently.

Pi extensions run with full system permissions. Review the source before installation.

## License

MIT
