// 公共工具：统一响应格式、错误处理、id 检查、查询参数解析。
// users.js 和 tasks.js 都会用到这里的函数。

// 24 位十六进制字符串 = 合法的 MongoDB ObjectId
var OBJECT_ID = /^[0-9a-fA-F]{24}$/;

function isObjectId(value) {
    return typeof value === 'string' && OBJECT_ID.test(value);
}

// 所有响应都从这里发出，保证格式永远是 { message, data }
function send(res, status, message, data) {
    res.status(status).json({ message: message, data: data === undefined ? {} : data });
}

// 自定义错误：校验时发现问题就 throw new ApiError(状态码, 提示语)
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// 包装每个路由处理函数：
//   ApiError    → 返回它自带的状态码和提示
//   其他任何错误 → 500，提示语是我们自己写的，不把 Mongoose 的报错发给客户端
function handle(fn) {
    return async function (req, res) {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof ApiError) {
                return send(res, err.status, err.message);
            }
            console.error(err);
            send(res, 500, 'Something went wrong on the server. Please try again later.');
        }
    };
}

// ---------- 请求体里常用的检查 ----------

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

// 没传、null、空字符串都当作"没给"
function isMissing(value) {
    return value === undefined || value === null || value === '';
}

// ---------- 查询参数（where / sort / select / skip / limit / count） ----------

// 读出一个 JSON 格式的参数；不合法就 400
function parseJsonParam(query, name) {
    var raw = query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
        throw new ApiError(400, "The '" + name + "' parameter was given more than once or is malformed.");
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new ApiError(400, "The '" + name + "' parameter must be valid JSON.");
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// where / sort / select 必须是 JSON 对象，比如 {"name": 1}
function parseObjectParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
        throw new ApiError(400, "The '" + name + "' parameter must be a JSON object.");
    }
    return value;
}

// skip / limit 必须是非负整数
function parseIntParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 0) {
        throw new ApiError(400, "The '" + name + "' parameter must be a non-negative integer.");
    }
    return value;
}

// count 必须是 true 或 false
function parseBoolParam(query, name) {
    var value = parseJsonParam(query, name);
    if (value === undefined) return false;
    if (typeof value !== 'boolean') {
        throw new ApiError(400, "The '" + name + "' parameter must be true or false.");
    }
    return value;
}

// sort 的每个值只能是 1（升序）或 -1（降序）
function checkSort(sort) {
    Object.keys(sort).forEach(function (field) {
        if (sort[field] !== 1 && sort[field] !== -1) {
            throw new ApiError(400, "Sort values must be 1 (ascending) or -1 (descending).");
        }
    });
}

// select 里除了 _id 以外，不能同时有"要"(1) 和"不要"(0)
function checkSelect(select) {
    var include = false, exclude = false;
    Object.keys(select).forEach(function (field) {
        var v = select[field];
        if (v !== 0 && v !== 1 && v !== true && v !== false) {
            throw new ApiError(400, "Select values must be 1 (include) or 0 (exclude).");
        }
        if (field === '_id') return;
        if (v === 1 || v === true) include = true; else exclude = true;
    });
    if (include && exclude) {
        throw new ApiError(400, "Select cannot mix including (1) and excluding (0) fields.");
    }
}

function parseSelect(query) {
    var select = parseObjectParam(query, 'select');
    if (select) checkSelect(select);
    return select;
}

// 执行一个查询；如果是客户端给的 where/sort/select 让数据库报错（比如未知运算符、
// 无法转换的值），那是请求的问题，返回 400 而不是 500
async function runClientQuery(query) {
    try {
        return await query;
    } catch (err) {
        if (err && (err.name === 'CastError' || err.name === 'MongoServerError' || err.name === 'StrictModeError')) {
            throw new ApiError(400, 'The query parameters contain an invalid value.');
        }
        throw err;
    }
}

// GET /users 和 GET /tasks 共用：把查询参数拼成一个 Mongoose 查询并执行。
// 筛选、排序、分页都交给数据库做（作业要求第 5 条）。
async function listDocuments(Model, query, defaultLimit) {
    var where = parseObjectParam(query, 'where') || {};
    var sort = parseObjectParam(query, 'sort');
    var select = parseSelect(query);
    var skip = parseIntParam(query, 'skip');
    var limit = parseIntParam(query, 'limit');
    var count = parseBoolParam(query, 'count');
    if (sort) checkSort(sort);

    if (count) {
        // 只返回数量：where 生效；显式给了 skip/limit 也生效
        var countQuery = Model.countDocuments(where);
        if (skip) countQuery = countQuery.skip(skip);
        if (limit) countQuery = countQuery.limit(limit);
        return runClientQuery(countQuery);
    }

    var q = Model.find(where);
    if (sort) q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip) q = q.skip(skip);
    var finalLimit = limit !== undefined ? limit : defaultLimit;
    if (finalLimit) q = q.limit(finalLimit); // tasks 默认 100；users 不限
    return runClientQuery(q.lean());
}

module.exports = {
    isObjectId: isObjectId,
    send: send,
    ApiError: ApiError,
    handle: handle,
    isNonEmptyString: isNonEmptyString,
    isMissing: isMissing,
    parseSelect: parseSelect,
    runClientQuery: runClientQuery,
    listDocuments: listDocuments
};
