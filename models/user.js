// 用户模型：规定 users 集合里每条数据长什么样
var mongoose = require('mongoose');

var UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    // 这个用户"未完成"任务的 _id 列表（存成字符串）
    pendingTasks: { type: [String], default: [] },
    // 服务器自动填创建时间；immutable 表示以后不能再改
    dateCreated: { type: Date, default: Date.now, immutable: true }
}, {
    versionKey: false // 不要在返回结果里出现 Mongoose 自带的 __v 字段
});

module.exports = mongoose.model('User', UserSchema);
