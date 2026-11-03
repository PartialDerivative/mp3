// /api/tasks 和 /api/tasks/:id 的全部端点
var User = require('../models/user');
var Task = require('../models/task');
var h = require('./helpers');
var ApiError = h.ApiError;

// ---------- 校验阶段：只读不写 ----------

// URL 里的 id：格式不对或查不到 → 404
async function findTaskOr404(id) {
    if (!h.isObjectId(id)) throw new ApiError(404, 'Task not found.');
    var task = await Task.findById(id);
    if (!task) throw new ApiError(404, 'Task not found.');
    return task;
}

// deadline 可以是日期字符串，也可以是毫秒时间戳
function readDeadline(value) {
    if (h.isMissing(value)) throw new ApiError(400, 'A task needs a deadline.');
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ApiError(400, 'The deadline must be a date.');
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) throw new ApiError(400, 'The deadline is not a valid date.');
    return date;
}

// 检查请求体里的字段格式（不查数据库）→ 有问题就 400。没给的字段用默认值。
function readTaskBody(req) {
    var body = req.body || {};

    if (!h.isNonEmptyString(body.name)) {
        throw new ApiError(400, 'A task needs a name (a non-empty string).');
    }
    var deadline = readDeadline(body.deadline);

    var description = body.description;
    if (description === undefined || description === null) description = '';
    if (typeof description !== 'string') throw new ApiError(400, 'description must be a string.');

    var completed = body.completed;
    if (completed === undefined || completed === null || completed === '') completed = false;
    if (completed === 'true') completed = true;     // 表单格式传来的是字符串
    if (completed === 'false') completed = false;
    if (typeof completed !== 'boolean') throw new ApiError(400, 'completed must be true or false.');

    var assignedUser = body.assignedUser;
    if (h.isMissing(assignedUser)) {
        assignedUser = '';
    } else if (!h.isObjectId(assignedUser)) {
        throw new ApiError(400, 'assignedUser is not a valid user id.');
    } else {
        assignedUser = assignedUser.toLowerCase();
    }

    var assignedUserName = body.assignedUserName;
    if (h.isMissing(assignedUserName)) {
        assignedUserName = undefined;               // 没给：后面自动填
    } else if (typeof assignedUserName !== 'string') {
        throw new ApiError(400, 'assignedUserName must be a string.');
    }

    return {
        name: body.name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

// 确定任务最终分配给谁：用户必须存在（否则 404），名字必须对得上（否则 400）
async function resolveAssignment(input) {
    if (input.assignedUser === '') {
        if (input.assignedUserName !== undefined && input.assignedUserName !== 'unassigned') {
            throw new ApiError(400, 'assignedUserName must be "unassigned" when the task has no assignedUser.');
        }
        return { assignedUser: '', assignedUserName: 'unassigned' };
    }
    var user = await User.findById(input.assignedUser);
    if (!user) throw new ApiError(404, 'The assigned user does not exist.');
    if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) {
        throw new ApiError(400, 'assignedUserName does not match the name of the assigned user.');
    }
    return { assignedUser: user._id.toString(), assignedUserName: user.name };
}

// ---------- 写入阶段 ----------

// 让用户这一边和任务保持一致：先从所有人的 pendingTasks 里移除，再按需加回
async function syncUsersForTask(task) {
    var taskId = task._id.toString();
    await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } });
    if (task.assignedUser !== '' && !task.completed) {
        await User.updateOne({ _id: task.assignedUser }, { $addToSet: { pendingTasks: taskId } });
    }
}

module.exports = function (router) {

    router.route('/tasks')

        // GET /api/tasks：列表，支持 where/sort/select/skip/limit/count，默认最多 100 条
        .get(h.handle(async function (req, res) {
            var data = await h.listDocuments(Task, req.query, 100);
            h.send(res, 200, 'OK', data);
        }))

        // POST /api/tasks：新建任务
        .post(h.handle(async function (req, res) {
            var input = readTaskBody(req);                      // 400
            var assignment = await resolveAssignment(input);    // 404 / 400

            var task = await Task.create({
                name: input.name,
                description: input.description,
                deadline: input.deadline,
                completed: input.completed,
                assignedUser: assignment.assignedUser,
                assignedUserName: assignment.assignedUserName
            });
            await syncUsersForTask(task);
            h.send(res, 201, 'Task created.', task);
        }));

    router.route('/tasks/:id')

        // GET /api/tasks/:id：只认 select 参数
        .get(h.handle(async function (req, res) {
            var id = req.params.id;
            if (!h.isObjectId(id)) throw new ApiError(404, 'Task not found.');
            var select = h.parseSelect(req.query);
            var q = Task.findById(id);
            if (select) q = q.select(select);
            var task = await h.runClientQuery(q.lean());
            if (!task) throw new ApiError(404, 'Task not found.');
            h.send(res, 200, 'OK', task);
        }))

        // PUT /api/tasks/:id：整体替换，没给的字段回到默认值
        .put(h.handle(async function (req, res) {
            var task = await findTaskOr404(req.params.id);      // 404
            var input = readTaskBody(req);                      // 400
            var assignment = await resolveAssignment(input);    // 404 / 400

            task.name = input.name;
            task.description = input.description;
            task.deadline = input.deadline;
            task.completed = input.completed;
            task.assignedUser = assignment.assignedUser;
            task.assignedUserName = assignment.assignedUserName;
            await task.save();                                  // dateCreated 不会变
            await syncUsersForTask(task);
            h.send(res, 200, 'Task updated.', task);
        }))

        // DELETE /api/tasks/:id：删除任务，并从用户的 pendingTasks 里移除
        .delete(h.handle(async function (req, res) {
            var task = await findTaskOr404(req.params.id);
            var taskId = task._id.toString();
            await Task.deleteOne({ _id: task._id });
            await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } });
            h.send(res, 200, 'Task deleted.', task);
        }));

    return router;
};
