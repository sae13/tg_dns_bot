export interface TxtRecordRequest {
  readonly zoneId: string;
  readonly name: string;
  readonly ttl: number;
  readonly characterStrings: readonly string[];
}

export type ReplaceSingleTxtRequest = TxtRecordRequest;

export type ReplaceSingleTxtResult =
  | { readonly status: 'created'; readonly recordId: string }
  | { readonly status: 'updated'; readonly recordId: string };

export interface StoredTxtRecord {
  readonly recordId: string;
  readonly wire: string;
}

export type ReadExactTxtResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'found'; readonly records: readonly StoredTxtRecord[] };

export type NumberedTxtInventoryResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'found'; readonly names: readonly string[] };

export type DeleteTxtRecordsResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'deleted' };

export interface RecordStorePort {
  appendSingleTxt(request: TxtRecordRequest): Promise<{ readonly status: 'created'; readonly recordId: string }>;
  replaceWithSingleTxt(request: ReplaceSingleTxtRequest): Promise<ReplaceSingleTxtResult>;
  readExactTxtRecords(request: Pick<TxtRecordRequest, 'zoneId' | 'name'>): Promise<ReadExactTxtResult>;
  listNumberedTxtRecords(
    request: { readonly zoneId: string; readonly rootName: string }
  ): Promise<NumberedTxtInventoryResult>;
  deleteTxtRecords(
    request: Pick<TxtRecordRequest, 'zoneId' | 'name'>
  ): Promise<DeleteTxtRecordsResult>;
}

export type RecordStoreErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'unsafe_target'
  | 'provider_unavailable'
  | 'provider_error'
  | 'provider_response'
  | 'ambiguous_result'
  | 'unknown_result'
  | 'budget_exhausted';

export class RecordStoreError extends Error {
  constructor(readonly code: RecordStoreErrorCode) {
    super(code);
    this.name = 'RecordStoreError';
  }
}
