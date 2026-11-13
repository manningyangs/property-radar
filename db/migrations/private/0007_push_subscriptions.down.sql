-- TASK-05C 回滚：删除浏览器推送订阅表（子表先于 0001 users，无跨表顾虑）
DROP INDEX IF EXISTS ix_push_subs_user_status;
DROP TABLE IF EXISTS push_subscriptions;
