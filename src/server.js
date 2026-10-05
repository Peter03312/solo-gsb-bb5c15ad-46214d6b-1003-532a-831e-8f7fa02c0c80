'use strict';

const path = require('path');
const express = require('express');
const { getDb } = require('./db');
const routes = require('./routes');
const scheduler = require('./scheduler');

const app = express();
app.use(express.json({ limit: '1mb' }));

const EDITOR_TOKEN = process.env.EDITOR_TOKEN || 'editor';

// 编辑者接口：要求 X-Editor-Token 头匹配
app.use('/api/editor', (req, res, next) => {
  const token = req.get('X-Editor-Token');
  if (!token || token !== EDITOR_TOKEN) {
    return res.status(401).json({
      status: 401,
      message: '需要编辑者口令：请在页面右上角输入口令（请求头 X-Editor-Token）',
    });
  }
  next();
});

app.use(routes);

// 静态浏览器界面
app.use(express.static(path.join(__dirname, '..', 'public')));

// /editor 直接返回编辑页
app.get('/editor', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'editor.html'));
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && typeof err === 'object' && err.status) {
    const { status, ...body } = err;
    return res.status(status).json({ status, message: err.message || '请求有误', ...body });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 400, message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ status: 500, message: '服务器内部错误' });
});

function start() {
  getDb(); // 初始化数据库
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  // 启动预约发布调度器：立即补跑停机期间到期的预约，之后每秒检查一次
  scheduler.start();
  const server = app.listen(port, host, () => {
    console.log(`地方口述史年表已启动`);
    console.log(`  访客年表:  http://localhost:${port}/`);
    console.log(`  编辑界面:  http://localhost:${port}/editor`);
    console.log(`  编辑口令来自环境变量 EDITOR_TOKEN（默认 editor）`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, EDITOR_TOKEN, scheduler };
