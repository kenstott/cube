import crypto from 'crypto';
import R from 'ramda';
import { createQuery, compile, queryClass, PreAggregations, QueryFactory } from '@cubejs-backend/schema-compiler';
import { v4 as uuidv4 } from 'uuid';
import { NativeInstance } from '@cubejs-backend/native';

export class CompilerApi {
  /**
   * Class constructor.
   * @param {SchemaFileRepository} repository
   * @param {DbTypeAsyncFn} dbType
   * @param {*} options
   */
  constructor(repository, dbType, options) {
    this.repository = repository;
    this.dbType = dbType;
    this.dialectClass = options.dialectClass;
    this.options = options || {};
    this.allowNodeRequire = options.allowNodeRequire == null ? true : options.allowNodeRequire;
    this.logger = this.options.logger;
    this.preAggregationsSchema = this.options.preAggregationsSchema;
    this.allowUngroupedWithoutPrimaryKey = this.options.allowUngroupedWithoutPrimaryKey;
    this.convertTzForRawTimeDimension = this.options.convertTzForRawTimeDimension;
    this.schemaVersion = this.options.schemaVersion;
    this.compileContext = options.compileContext;
    this.allowJsDuplicatePropsInSchema = options.allowJsDuplicatePropsInSchema;
    this.sqlCache = options.sqlCache;
    this.standalone = options.standalone;
    this.nativeInstance = this.createNativeInstance();
  }

  setGraphQLSchema(schema) {
    this.graphqlSchema = schema;
  }

  getGraphQLSchema() {
    return this.graphqlSchema;
  }

  createNativeInstance() {
    return new NativeInstance();
  }

  async getCompilers({ requestId } = {}) {
    let compilerVersion = (
      this.schemaVersion && await this.schemaVersion() ||
      'default_schema_version'
    );

    if (typeof compilerVersion === 'object') {
      compilerVersion = JSON.stringify(compilerVersion);
    }

    if (this.options.devServer) {
      const files = await this.repository.dataSchemaFiles();
      compilerVersion += `_${crypto.createHash('md5').update(JSON.stringify(files)).digest('hex')}`;
    }

    if (!this.compilers || this.compilerVersion !== compilerVersion) {
      const startCompilingTime = new Date().getTime();
      try {
        this.logger(this.compilers ? 'Recompiling schema' : 'Compiling schema', {
          version: compilerVersion,
          requestId
        });

        this.compilers = await compile(this.repository, {
          allowNodeRequire: this.allowNodeRequire,
          compileContext: this.compileContext,
          allowJsDuplicatePropsInSchema: this.allowJsDuplicatePropsInSchema,
          standalone: this.standalone,
          nativeInstance: this.nativeInstance,
        });
        this.compilerVersion = compilerVersion;
        this.queryFactory = await this.createQueryFactory(this.compilers);

        this.logger('Compiling schema completed', {
          version: compilerVersion,
          requestId,
          duration: ((new Date()).getTime() - startCompilingTime),
        });
      } catch (e) {
        this.logger('Compiling schema error', {
          version: compilerVersion,
          requestId,
          duration: ((new Date()).getTime() - startCompilingTime),
          error: (e.stack || e).toString()
        });
        throw e;
      }
    }

    return this.compilers;
  }

  async createQueryFactory(compilers) {
    const { cubeEvaluator } = compilers;

    const cubeToQueryClass = R.fromPairs(
      await Promise.all(
        cubeEvaluator.cubeNames().map(async cube => {
          const dataSource = cubeEvaluator.cubeFromPath(cube).dataSource ?? 'default';
          const dbType = await this.getDbType(dataSource);
          const dialectClass = this.getDialectClass(dataSource, dbType);
          return [cube, queryClass(dbType, dialectClass)];
        })
      )
    );
    return new QueryFactory(cubeToQueryClass);
  }

  async getDbType(dataSource = 'default') {
    return this.dbType({ dataSource, });
  }

  getDialectClass(dataSource = 'default', dbType) {
    return this.dialectClass && this.dialectClass({ dataSource, dbType });
  }

  async getSqlGenerator(query, dataSource) {
    const dbType = await this.getDbType(dataSource);
    const compilers = await this.getCompilers({ requestId: query.requestId });
    let sqlGenerator = await this.createQueryByDataSource(compilers, query, dataSource);

    if (!sqlGenerator) {
      throw new Error(`Unknown dbType: ${dbType}`);
    }

    dataSource = compilers.compiler.withQuery(sqlGenerator, () => sqlGenerator.dataSource);
    const _dbType = await this.getDbType(dataSource);
    if (dataSource !== 'default' && dbType !== _dbType) {
      // TODO consider more efficient way than instantiating query
      sqlGenerator = await this.createQueryByDataSource(
        compilers,
        query,
        dataSource
      );

      if (!sqlGenerator) {
        throw new Error(`Can't find dialect for '${dataSource}' data source: ${_dbType}`);
      }
    }

    return { sqlGenerator, compilers };
  }

  async getSql(query, options = {}) {
    const { includeDebugInfo, exportAnnotatedSql } = options;
    const { sqlGenerator, compilers } = await this.getSqlGenerator(query);

    const getSqlFn = () => compilers.compiler.withQuery(sqlGenerator, () => ({
      external: sqlGenerator.externalPreAggregationQuery(),
      sql: sqlGenerator.buildSqlAndParams(exportAnnotatedSql),
      lambdaQueries: sqlGenerator.buildLambdaQuery(),
      timeDimensionAlias: sqlGenerator.timeDimensions[0] && sqlGenerator.timeDimensions[0].unescapedAliasName(),
      timeDimensionField: sqlGenerator.timeDimensions[0] && sqlGenerator.timeDimensions[0].dimension,
      order: sqlGenerator.order,
      cacheKeyQueries: sqlGenerator.cacheKeyQueries(),
      preAggregations: sqlGenerator.preAggregations.preAggregationsDescription(),
      dataSource: sqlGenerator.dataSource,
      aliasNameToMember: sqlGenerator.aliasNameToMember,
      rollupMatchResults: includeDebugInfo ?
        sqlGenerator.preAggregations.rollupMatchResultDescriptions() : undefined,
      canUseTransformedQuery: sqlGenerator.preAggregations.canUseTransformedQuery()
    }));

    if (this.sqlCache) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { requestId, ...keyOptions } = query;
      const key = { query: keyOptions, options };
      return compilers.compilerCache.getQueryCache(key).cache(['sql'], getSqlFn);
    } else {
      return getSqlFn();
    }
  }

  async compilerCacheFn(requestId, key, path) {
    const compilers = await this.getCompilers({ requestId });
    if (this.sqlCache) {
      return (subKey, cacheFn) => compilers.compilerCache.getQueryCache(key).cache(path.concat(subKey), cacheFn);
    } else {
      return (subKey, cacheFn) => cacheFn();
    }
  }

  async preAggregations(filter) {
    const { cubeEvaluator } = await this.getCompilers();
    return cubeEvaluator.preAggregations(filter);
  }

  async scheduledPreAggregations() {
    const { cubeEvaluator } = await this.getCompilers();
    return cubeEvaluator.scheduledPreAggregations();
  }

  async createQueryByDataSource(compilers, query, dataSource) {
    const dbType = await this.getDbType(dataSource);

    return this.createQuery(compilers, dbType, this.getDialectClass(dataSource, dbType), query);
  }

  createQuery(compilers, dbType, dialectClass, query) {
    return createQuery(
      compilers,
      dbType,
      {
        ...query,
        dialectClass,
        externalDialectClass: this.options.externalDialectClass,
        externalDbType: this.options.externalDbType,
        preAggregationsSchema: this.preAggregationsSchema,
        allowUngroupedWithoutPrimaryKey: this.allowUngroupedWithoutPrimaryKey,
        convertTzForRawTimeDimension: this.convertTzForRawTimeDimension,
        queryFactory: this.queryFactory,
      }
    );
  }

  async metaConfig(options = {}) {
    return (await this.getCompilers(options)).metaTransformer.cubes;
  }

  async metaConfigExtended(options) {
    const { metaTransformer } = await this.getCompilers(options);
    return {
      metaConfig: metaTransformer?.cubes,
      cubeDefinitions: metaTransformer?.cubeEvaluator?.cubeDefinitions,
    };
  }

  async cubeNameToDataSource(query) {
    const { cubeEvaluator } = await this.getCompilers({ requestId: query.requestId });
    return cubeEvaluator
      .cubeNames()
      .map(
        (cube) => ({ [cube]: cubeEvaluator.cubeFromPath(cube).dataSource || 'default' })
      ).reduce((a, b) => ({ ...a, ...b }), {});
  }

  async dataSources(orchestratorApi, query) {
    const cubeNameToDataSource = await this.cubeNameToDataSource(query || { requestId: `datasources-${uuidv4()}` });

    let dataSources = Object.keys(cubeNameToDataSource).map(c => cubeNameToDataSource[c]);

    dataSources = [...new Set(dataSources)];

    dataSources = await Promise.all(
      dataSources.map(async (dataSource) => {
        try {
          await orchestratorApi.driverFactory(dataSource);
          const dbType = await this.getDbType(dataSource);
          return { dataSource, dbType };
        } catch (err) {
          return null;
        }
      })
    );

    return {
      dataSources: dataSources.filter((source) => source),
    };
  }

  canUsePreAggregationForTransformedQuery(transformedQuery, refs) {
    return PreAggregations.canUsePreAggregationForTransformedQueryFn(transformedQuery, refs);
  }
}
