// MetadataObjectService — business logic for the three RFC §9.1
// read-side endpoints (list, get, history). Wraps
// MetadataObjectRepository + the @erp/metadata resolver.
//
// Routes call the service; the service returns Result<T, E>; the
// route Result.match()es into HTTP responses (RFC 7807 on err).

import { Result, type Layer, type ObjectType, type Result as ResultT } from "@erp/core";
import { type MetadataObjectRepository, type MetaObjectRow } from "@erp/db";
import { resolve, type ResolvedObject } from "@erp/metadata";

export interface ListInput {
  readonly tenantId: string;
  readonly type?: ObjectType;
  readonly layer?: Layer;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListOutput {
  readonly items: readonly MetaObjectRow[];
  readonly limit: number;
  readonly offset: number;
}

export type ServiceError = { readonly kind: "object_not_found"; readonly object_id: string };

export class MetadataObjectService {
  constructor(private readonly repo: MetadataObjectRepository) {}

  async list(input: ListInput): Promise<ListOutput> {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const items = await this.repo.list(input.tenantId, {
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.layer !== undefined ? { layer: input.layer } : {}),
      limit,
      offset,
    });
    return { items, limit, offset };
  }

  async get(tenantId: string, objectId: string): Promise<ResultT<ResolvedObject, ServiceError>> {
    const r = await resolve({ tenant_id: tenantId, object_id: objectId }, this.repo);
    if (Result.isErr(r)) {
      return Result.err({ kind: "object_not_found", object_id: objectId });
    }
    return Result.ok(r.value);
  }

  async history(tenantId: string, objectId: string): Promise<readonly MetaObjectRow[]> {
    return this.repo.history(tenantId, objectId);
  }
}
