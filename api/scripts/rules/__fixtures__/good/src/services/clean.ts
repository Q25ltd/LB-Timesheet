export function list(ctx: TenantContext, dto: ListDto) {
  return repo.listOwn(ctx, dto.limit);
}
