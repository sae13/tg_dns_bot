export interface TxtRecord {
  readonly name: string;
  readonly ttl: number;
  readonly value: string;
}

export type TxtResolution =
  | { readonly status: 'found'; readonly records: readonly TxtRecord[] }
  | { readonly status: 'nxdomain' }
  | { readonly status: 'nodata' }
  | { readonly status: 'dns_error'; readonly responseCode: number }
  | { readonly status: 'network_error' }
  | { readonly status: 'timeout' }
  | { readonly status: 'invalid_response' };

export interface TxtResolverPort {
  resolveTxt(name: string): Promise<TxtResolution>;
}
