// /api/users 和 /api/users/:id 的全部端点
var User = require('../models/user');
var Task = require('../models/task');
var h = require('./helpers');
var ApiError = h.ApiError;

var EMAIL = /^[^\s@]+@[^\s@]+$/;

// ---------- 校验阶段：只读不写 ----------

// URL 里的 id：格式不对或查不到 → 404
async function findUserOr404(id) {
    if (!h.isObjectId(id)) throw new ApiError(404, 'User not found.');
    var user = await User.findById(id);
    if (!user) throw new ApiError(404, 'User not found.');
    return user;
}

// 检查请求体里的字段格式（不查数据库）→ 有问题就 400
function readUserBody(req) {
    var body = req.body || {};

    if (!h.isNonEmptyString(body.name)) {
        throw new ApiError(400, 'A user needs a name (a non-empty string).');
    }
    if (!h.isNonEmptyString(body.email)) {
        throw new ApiError(400, 'A user needs an email (a non-empty string).');
    }
    if (!EMAIL.test(body.email.trim())) {
        throw new ApiError(400, 'The email address is not valid.');
    }

    // 没给 pendingTasks 就当作空列表
    var pending = body.pendingTasks;
    if (pending === undefined || pending === null) pending = [];
    // 表单格式（x-www-form-urlencoded）只传一个值时会是字符串，包成列表
    if (typeof pending === 'string' && req.is('application/x-www-form-urlencoded')) pending = [pending];
    if (!Array.isArray(pending)) {
        throw new ApiError(400, 'pendingTasks must be a list of task ids.');
    }
    pending.forEach(function (id) {
        if (!h.isObjectId(id)) {
            throw new ApiError(400, "'" + id + "' in pendingTasks is not a valid task id.");
        }
    });

    // 统一成小写并去重
    var ids = Array.from(new Set(pending.map(function (id) { return id.toLowerCase(); })));
    return { name: body.name, email: body.email, pendingTasks: ids };
}

// 邮箱不能被"别的"用户占用（自己原来的邮箱没问题）→ 400
async function checkEmailFree(email, ownId) {
    var filter = { email: email };
    if (ownId) filter._id = { $ne: ownId };
    if (await User.exists(filter)) {
        throw new ApiError(400, 'This email is already used by another user.');
    }
}

// pendingTasks 里的任务必须都存在（否则 404），且都未完成（否则 400）
async function checkPendingTasks(ids) {
    if (ids.length === 0) return;
    var tasks = await Task.find({ _id: { $in: ids } });
    var found = new Set(tasks.map(function (t) { return t._id.toString(); }));
    ids.forEach(function (id) {
        if (!found.has(id)) throw new ApiError(404, 'Task ' + id + ' in pendingTasks does not exist.');
    });
    tasks.forEach(function (t) {
        if (t.completed) {
            throw new ApiError(400, 'Task ' + t._id + ' is already completed, so it cannot be in pendingTasks.');
        }
    });
}

// ---------- 写入阶段：所有检查通过之后才执行 ----------

// 让任务这一边和用户的新 pendingTasks 保持一致
async function syncTasksForUser(userId, userName, ids) {
    // 1. 原来分配给这个用户、但不在新列表里的未完成任务 → 取消分配
    await Task.updateMany(
        { assignedUser: userId, completed: false, _id: { $nin: ids } },
        { assignedUser: '', assignedUserName: 'unassigned' }
    );
    if (ids.length > 0) {
        // 2. 新列表里的任务如果在别人的 pendingTasks 里 → 从别人那里删掉
        await User.updateMany(
            { _id: { $ne: userId }, pendingTasks: { $in: ids } },
            { $pullAll: { pendingTasks: ids } }
        );
    }
    // 3. 新列表里的任务分配给这个用户；这个用户名下所有任务（包括已完成的）的名字都更新
    await Task.updateMany(
        { $or: [{ _id: { $in: ids } }, { assignedUser: userId }] },
        { assignedUser: userId, assignedUserName: userName }
    );
}

module.exports = function (router) {

    router.route('/users')

        // GET /api/users：列表，支持 where/sort/select/skip/limit/count，users 默认不限条数
        .get(h.handle(async function (req, res) {
            var data = await h.listDocuments(User, req.query, undefined);
            h.send(res, 200, 'OK', data);
        }))

        // POST /api/users：新建用户
        .post(h.handle(async function (req, res) {
            var input = readUserBody(req);                 // 400
            await checkEmailFree(input.email, null);       // 400
            await checkPendingTasks(input.pendingTasks);   // 404 / 400

            var user = await User.create(input);
            await syncTasksForUser(user._id.toString(), user.name, input.pendingTasks);
            h.send(res, 201, 'User created.', user);
        }));

    router.route('/users/:id')

        // GET /api/users/:id：只认 select 参数
        .get(h.handle(async function (req, res) {
            var id = req.params.id;
            if (!h.isObjectId(id)) throw new ApiError(404, 'User not found.');
            var select = h.parseSelect(req.query);
            var q = User.findById(id);
            if (select) q = q.select(select);
            var user = await h.runClientQuery(q.lean());
            if (!user) throw new ApiError(404, 'User not found.');
            h.send(res, 200, 'OK', user);
        }))

        // PUT /api/users/:id：整体替换
        .put(h.handle(async function (req, res) {
            var user = await findUserOr404(req.params.id);  // 404
            var input = readUserBody(req);                  // 400
            await checkEmailFree(input.email, user._id);    // 400
            await checkPendingTasks(input.pendingTasks);    // 404 / 400

            user.name = input.name;
            user.email = input.email;
            user.pendingTasks = input.pendingTasks;
            await user.save();                              // dateCreated 不会变
            await syncTasksForUser(user._id.toString(), user.name, input.pendingTasks);
            h.send(res, 200, 'User updated.', user);
        }))

        // DELETE /api/users/:id：删除用户，他名下的任务（包括已完成的）全部取消分配
        .delete(h.handle(async function (req, res) {
            var user = await findUserOr404(req.params.id);
            await User.deleteOne({ _id: user._id });
            await Task.updateMany(
                { assignedUser: user._id.toString() },
                { assignedUser: '', assignedUserName: 'unassigned' }
            );
            res.status(204).end();
        }));

    return router;
};
