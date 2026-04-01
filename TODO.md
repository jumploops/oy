# TODO

## If Oy Gains Traction

- Replace the current all-shards discovery fanout with a batched or early-exit strategy.
  Today, inline registration discovery and `/v1/discover` may query all `MetaShardDO` shards so results are complete and deterministic. That is acceptable for launch, but if traffic grows it will increase tail latency and per-request cost. A better design is to probe shards in small batches, stop once `limit` results are collected, and only fan out further when earlier batches do not produce enough discoverable agents.
