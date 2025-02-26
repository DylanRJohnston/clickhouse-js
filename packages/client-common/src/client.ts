import type {
  BaseClickHouseClientConfigOptions,
  ClickHouseSettings,
  Connection,
  ConnectionParams,
  ConnExecResult,
  IsSame,
  LogWriter,
  MakeResultSet,
  WithClickHouseSummary,
  WithResponseHeaders,
} from '@clickhouse/client-common'
import { type DataFormat, DefaultLogger } from '@clickhouse/client-common'
import type { InsertValues, NonEmptyArray } from './clickhouse_types'
import type { ImplementationDetails, ValuesEncoder } from './config'
import { getConnectionParams, prepareConfigWithURL } from './config'
import type { ConnPingResult } from './connection'
import type { BaseResultSet } from './result'

export interface BaseQueryParams {
  /** ClickHouse's settings that can be applied on query level. */
  clickhouse_settings?: ClickHouseSettings
  /** Parameters for query binding. https://clickhouse.com/docs/en/interfaces/http/#cli-queries-with-parameters */
  query_params?: Record<string, unknown>
  /** AbortSignal instance to cancel a request in progress. */
  abort_signal?: AbortSignal
  /** A specific `query_id` that will be sent with this request.
   *  If it is not set, a random identifier will be generated automatically by the client. */
  query_id?: string
  /** A specific ClickHouse Session id for this query.
   *  If it is not set, {@link BaseClickHouseClientConfigOptions.session_id} will be used.
   *  @default undefined (no override) */
  session_id?: string
  /** A specific list of roles to use for this query.
   *  If it is not set, {@link BaseClickHouseClientConfigOptions.role} will be used.
   *  @default undefined (no override) */
  role?: string | Array<string>
  /** When defined, overrides {@link BaseClickHouseClientConfigOptions.auth} for this particular request.
   *  @default undefined (no override) */
  auth?:
    | {
        username: string
        password: string
      }
    | { access_token: string }
  /** OpenTelemetry headers to propagate to ClickHouse.
   *  @default undefined (no override) */
  opentelemetry_headers?: {
    traceparent?: string
    tracestate?: string
  }
}

export interface QueryParams extends BaseQueryParams {
  /** Statement to execute. */
  query: string
  /** Format of the resulting dataset. */
  format?: DataFormat
}

/** Same parameters as {@link QueryParams}, but with `format` field as a type */
export type QueryParamsWithFormat<Format extends DataFormat> = Omit<
  QueryParams,
  'format'
> & { format?: Format }

/** If the Format is not a literal type, fall back to the default behavior of the ResultSet,
 *  allowing to call all methods with all data shapes variants,
 *  and avoiding generated types that include all possible DataFormat literal values. */
export type QueryResult<Stream, Format extends DataFormat> =
  IsSame<Format, DataFormat> extends true
    ? BaseResultSet<Stream, unknown>
    : BaseResultSet<Stream, Format>

export type ExecParams = BaseQueryParams & {
  /** Statement to execute (including the FORMAT clause). By default, the query will be sent in the request body;
   *  If {@link ExecParamsWithValues.values} are defined, the query is sent as a request parameter,
   *  and the values are sent in the request body instead. */
  query: string
  /** If set to `false`, the client _will not_ decompress the response stream, even if the response compression
   *  was requested by the client via the {@link BaseClickHouseClientConfigOptions.compression.response } setting.
   *  This could be useful if the response stream is passed to another application as-is,
   *  and the decompression is handled there.
   *  @note 1) Node.js only. This setting will have no effect on the Web version.
   *  @note 2) In case of an error, the stream will be decompressed anyway, regardless of this setting.
   *  @default true */
  decompress_response_stream?: boolean
}
export type ExecParamsWithValues<Stream> = ExecParams & {
  /** If you have a custom INSERT statement to run with `exec`, the data from this stream will be inserted.
   *
   *  NB: the data in the stream is expected to be serialized accordingly to the FORMAT clause
   *  used in {@link ExecParams.query} in this case.
   *
   *  @see https://clickhouse.com/docs/en/interfaces/formats */
  values: Stream
}

export type CommandParams = ExecParams
export type CommandResult = { query_id: string } & WithClickHouseSummary &
  WithResponseHeaders

export type InsertResult = {
  /**
   * Indicates whether the INSERT statement was executed on the server.
   * Will be `false` if there was no data to insert.
   * For example: if {@link InsertParams.values} was an empty array,
   * the client does not send any requests to the server, and {@link executed} is false.
   */
  executed: boolean
  /**
   * Empty string if {@link executed} is false.
   * Otherwise, either {@link InsertParams.query_id} if it was set, or the id that was generated by the client.
   */
  query_id: string
} & WithClickHouseSummary &
  WithResponseHeaders

export type ExecResult<Stream> = ConnExecResult<Stream>
export type PingResult = ConnPingResult

/** {@link except} field contains a non-empty list of columns to exclude when generating `(* EXCEPT (...))` clause */
export interface InsertColumnsExcept {
  except: NonEmptyArray<string>
}

export interface InsertParams<Stream = unknown, T = unknown>
  extends BaseQueryParams {
  /** Name of a table to insert into. */
  table: string
  /** A dataset to insert. */
  values: InsertValues<Stream, T>
  /** Format of the dataset to insert. Default: `JSONCompactEachRow` */
  format?: DataFormat
  /**
   * Allows to specify which columns the data will be inserted into.
   * Accepts either an array of strings (column names) or an object of {@link InsertColumnsExcept} type.
   * Examples of generated queries:
   *
   * - An array such as `['a', 'b']` will generate: `INSERT INTO table (a, b) FORMAT DataFormat`
   * - An object such as `{ except: ['a', 'b'] }` will generate: `INSERT INTO table (* EXCEPT (a, b)) FORMAT DataFormat`
   *
   * By default, the data is inserted into all columns of the {@link InsertParams.table},
   * and the generated statement will be: `INSERT INTO table FORMAT DataFormat`.
   *
   * See also: https://clickhouse.com/docs/en/sql-reference/statements/insert-into */
  columns?: NonEmptyArray<string> | InsertColumnsExcept
}

export class ClickHouseClient<Stream = unknown> {
  private readonly clientClickHouseSettings: ClickHouseSettings
  private readonly connectionParams: ConnectionParams
  private readonly connection: Connection<Stream>
  private readonly makeResultSet: MakeResultSet<Stream>
  private readonly valuesEncoder: ValuesEncoder<Stream>
  private readonly sessionId?: string
  private readonly role?: string | Array<string>
  private readonly logWriter: LogWriter

  constructor(
    config: BaseClickHouseClientConfigOptions & ImplementationDetails<Stream>,
  ) {
    const logger = config?.log?.LoggerClass
      ? new config.log.LoggerClass()
      : new DefaultLogger()
    const configWithURL = prepareConfigWithURL(
      config,
      logger,
      config.impl.handle_specific_url_params ?? null,
    )
    this.connectionParams = getConnectionParams(configWithURL, logger)
    this.logWriter = this.connectionParams.log_writer
    this.clientClickHouseSettings = this.connectionParams.clickhouse_settings
    this.sessionId = config.session_id
    this.role = config.role
    this.connection = config.impl.make_connection(
      configWithURL,
      this.connectionParams,
    )
    this.makeResultSet = config.impl.make_result_set
    this.valuesEncoder = config.impl.values_encoder
  }

  /**
   * Used for most statements that can have a response, such as `SELECT`.
   * FORMAT clause should be specified separately via {@link QueryParams.format} (default is `JSON`).
   * Consider using {@link ClickHouseClient.insert} for data insertion, or {@link ClickHouseClient.command} for DDLs.
   * Returns an implementation of {@link BaseResultSet}.
   *
   * See {@link DataFormat} for the formats supported by the client.
   */
  async query<Format extends DataFormat = 'JSON'>(
    params: QueryParamsWithFormat<Format>,
  ): Promise<QueryResult<Stream, Format>> {
    const format = params.format ?? 'JSON'
    const query = formatQuery(params.query, format)
    const queryParams = this.withClientQueryParams(params)
    const { stream, query_id, response_headers } = await this.connection.query({
      query,
      ...queryParams,
    })
    return this.makeResultSet(
      stream,
      format,
      query_id,
      (err) => {
        this.logWriter.error({
          err,
          module: 'Client',
          message: 'Error while processing the ResultSet.',
          args: {
            session_id: queryParams.session_id,
            role: queryParams.role,
            query,
            query_id,
          },
        })
      },
      response_headers,
    )
  }

  /**
   * It should be used for statements that do not have any output,
   * when the format clause is not applicable, or when you are not interested in the response at all.
   * Response stream is destroyed immediately as we do not expect useful information there.
   * Examples of such statements are DDLs or custom inserts.
   *
   * @note if you have a custom query that does not work with {@link ClickHouseClient.query},
   * and you are interested in the response data, consider using {@link ClickHouseClient.exec}.
   */
  async command(params: CommandParams): Promise<CommandResult> {
    const query = removeTrailingSemi(params.query.trim())
    return await this.connection.command({
      query,
      ...this.withClientQueryParams(params),
    })
  }

  /**
   * Similar to {@link ClickHouseClient.command}, but for the cases where the output _is expected_,
   * but format clause is not applicable. The caller of this method _must_ consume the stream,
   * as the underlying socket will not be released until then, and the request will eventually be timed out.
   *
   * @note it is not intended to use this method to execute the DDLs, such as `CREATE TABLE` or similar;
   * use {@link ClickHouseClient.command} instead.
   */
  async exec(
    params: ExecParams | ExecParamsWithValues<Stream>,
  ): Promise<ExecResult<Stream>> {
    const query = removeTrailingSemi(params.query.trim())
    const values = 'values' in params ? params.values : undefined
    const decompress_response_stream = params.decompress_response_stream ?? true
    return await this.connection.exec({
      query,
      values,
      decompress_response_stream,
      ...this.withClientQueryParams(params),
    })
  }

  /**
   * The primary method for data insertion. It is recommended to avoid arrays in case of large inserts
   * to reduce application memory consumption and consider streaming for most of such use cases.
   * As the insert operation does not provide any output, the response stream is immediately destroyed.
   *
   * @note in case of a custom insert operation (e.g., `INSERT FROM SELECT`),
   * consider using {@link ClickHouseClient.command}, passing the entire raw query there
   * (including the `FORMAT` clause).
   */
  async insert<T>(params: InsertParams<Stream, T>): Promise<InsertResult> {
    if (Array.isArray(params.values) && params.values.length === 0) {
      return { executed: false, query_id: '', response_headers: {} }
    }

    const format = params.format || 'JSONCompactEachRow'
    this.valuesEncoder.validateInsertValues(params.values, format)

    const query = getInsertQuery(params, format)
    const result = await this.connection.insert({
      query,
      values: this.valuesEncoder.encodeValues(params.values, format),
      ...this.withClientQueryParams(params),
    })
    return { ...result, executed: true }
  }

  /**
   * Health-check request. It does not throw if an error occurs -
   * the error is returned inside the result object.
   */
  async ping(): Promise<PingResult> {
    return await this.connection.ping()
  }

  /**
   * Shuts down the underlying connection.
   * This method should ideally be called only once per application lifecycle,
   * for example, during the graceful shutdown phase.
   */
  async close(): Promise<void> {
    return await this.connection.close()
  }

  private withClientQueryParams(params: BaseQueryParams): BaseQueryParams {
    return {
      clickhouse_settings: {
        ...this.clientClickHouseSettings,
        ...params.clickhouse_settings,
      },
      query_params: params.query_params,
      abort_signal: params.abort_signal,
      query_id: params.query_id,
      session_id: params.session_id ?? this.sessionId,
      role: params.role ?? this.role,
      auth: params.auth,
      opentelemetry_headers: params.opentelemetry_headers,
    }
  }
}

function formatQuery(query: string, format: DataFormat): string {
  query = query.trim()
  query = removeTrailingSemi(query)
  return query + ' \nFORMAT ' + format
}

function removeTrailingSemi(query: string) {
  let lastNonSemiIdx = query.length
  for (let i = lastNonSemiIdx; i > 0; i--) {
    if (query[i - 1] !== ';') {
      lastNonSemiIdx = i
      break
    }
  }
  if (lastNonSemiIdx !== query.length) {
    return query.slice(0, lastNonSemiIdx)
  }
  return query
}

function isInsertColumnsExcept(obj: unknown): obj is InsertColumnsExcept {
  return (
    obj !== undefined &&
    obj !== null &&
    typeof obj === 'object' &&
    // Avoiding ESLint no-prototype-builtins error
    Object.prototype.hasOwnProperty.call(obj, 'except')
  )
}

function getInsertQuery<T>(
  params: InsertParams<T>,
  format: DataFormat,
): string {
  let columnsPart = ''
  if (params.columns !== undefined) {
    if (Array.isArray(params.columns) && params.columns.length > 0) {
      columnsPart = ` (${params.columns.join(', ')})`
    } else if (
      isInsertColumnsExcept(params.columns) &&
      params.columns.except.length > 0
    ) {
      columnsPart = ` (* EXCEPT (${params.columns.except.join(', ')}))`
    }
  }
  return `INSERT INTO ${params.table.trim()}${columnsPart} FORMAT ${format}`
}
