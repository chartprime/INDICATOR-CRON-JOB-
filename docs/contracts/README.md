# Contract index

[Handbook](../README.md)

These are distinct boundaries, not interchangeable versions of one schema.

| Boundary | Contract | Primary consumer |
|---|---|---|
| Provider archive facts | [Databento](databento/v1/databento-v1.md), [Tardis](tardis/v1/tardis-v1.md) | Acquisition and decoders |
| Historical canonical records | [Market observation v1](market-observation/v1/README.md) | Conversion and future historical readers |
| S3 publication and discovery | [Archive v1](archive/v1/README.md) | Publishers and catalog readers |
| Historical read requests and responses | [Archive query v1](archive-query/v1/archive-query-v1.md) | Data service ⇄ isolated reader workers |
| Historical order-flow studies | [Archive study v1](archive-study/v1/archive-study-v1.md) | Historical Mode ⇄ gateway study route |
| Live Binance normalization | [Canonical event v1](binance-canonical-event/v1/binance-canonical-event-v1.md) | Live runtime and capture |
| Binance book state | [Order book v2](binance-order-book/v2/binance-order-book-v2.md) | Book consumers; v1 remains historical |
| Feed health | [Binance feed health v1](binance-feed-health/v1/binance-feed-health-v1.md) | Recovery and monitoring |
| Live persistence | [Storage layer v1](storage-layer/v1/storage-layer-v1.md) | SQLite capture/warm-up |
| Frontend transport | [WebSocket frames v1](ws-frame-contract/v1/ws-frame-contract-v1.md) | Frontend runtime client |
| dxFeed-specific boundaries | [Events](dxfeed-canonical-event/v1/dxfeed-canonical-event-v1.md), [book](dxfeed-order-book/v1/dxfeed-order-book-v1.md), [storage](dxfeed-storage-layer/v1/dxfeed-storage-layer-v1.md) | Licensed provider integration; deployment and present entitlement are operational evidence, not contract semantics |

Executable validators and their tests decide whether a value is accepted; prose explains its meaning. The historical contract supports more families than the current archive worker converts. Schema support does not establish deployed ingestion, available history or licensed access.

An incompatible meaning or shape requires explicit versioning and consumer migration. Keep provider population, event-time precision, identity evidence and lineage intact across boundaries. Successful structural validation does not upgrade a record's market-data quality or establish complete coverage.
