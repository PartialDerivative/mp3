// 任务模型：规定 tasks 集合里每条数据长什么样
var mongoose = require('mongoose');

var TaskSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, default: '' },
    deadline: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    // 分配给哪个用户（存那个用户的 _id 字符串）；"" 表示没分配
    assignedUser: { type: String, default: '' },
    assignedUserName: { type: String, default: 'unassigned' },
    dateCreated: { type: Date, default: Date.now, immutable: true }
}, {
    versionKey: false
});

module.exports = mongoose.model('Task', TaskSchema);
