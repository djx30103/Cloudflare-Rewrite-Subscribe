# 使用 Cloudflare Workers + D1 搭建订阅 Rewrite 服务

## 第一步：创建数据库

1. 进入 Workers & Pages → D1。
2. 创建一个任意名称的数据库，例如 `subscribe-rewrite`。

## 第二步：创建数据表

1. 进入刚刚创建的数据库。
2. 创建数据表。
3. 进入控制台（console），执行以下 SQL 语句：

    ```sql
     CREATE TABLE groups (
        cipher TEXT,
        source TEXT,
        priority INTEGER DEFAULT '0',
        `index` INTEGER DEFAULT '0',
        action TEXT DEFAULT 'must add',
        value TEXT,
        proxies TEXT
    );

    CREATE TABLE proxies (
        cipher TEXT,
        source TEXT,
        priority INTEGER DEFAULT '0',
        `index` INTEGER DEFAULT '0',
        action TEXT DEFAULT 'must add',
        value TEXT
    );

    CREATE TABLE rules (
        cipher TEXT,
        source TEXT,
        priority INTEGER DEFAULT '0',
        `index` INTEGER DEFAULT '0',
        action TEXT DEFAULT 'must add',
        value TEXT
    );

    CREATE TABLE others (
        cipher TEXT,
        source TEXT,
        priority INTEGER DEFAULT '0',
        `index` INTEGER DEFAULT '0',
        action TEXT DEFAULT 'must add',
        field TEXT,
        value TEXT
    );
    ```

## 第三步：创建 Worker

1. 创建一个 Worker。
2. 复制 `worker.js` 中的代码，替换开头的`const CIPHER_LIST = ["xxx1", "xxx2"]` 中的密钥，替换`xxx...`部分，不填的话则不使用密钥。<br>`注意不要包含 "&" 和 "," 否则验证无法通过！！！`<br>`建议添加了节点的务必填入密钥，否则别人访问你的服务也能使用你添加的节点！！！` 
3. 将整个js内容，替换 Worker 的 JavaScript 代码并部署。

## 第四步：绑定数据库

1. 进入 设置 → 变量 → D1 数据库绑定。
2. 绑定刚刚创建的数据库，变量名为：`DB`。

## 使用方法
通过 Worker 地址，`cipher`、`source` 和 `config` 参数拼接为订阅链接。例如：
- `https://example.workers.dev/?cipher=xxx&source=surge&config=https%3A%2F%2Fsub.example.com`
- `https://example.workers.dev/?cipher=xxx1,xxx2,xxx3&source=clash&config=https%3A%2F%2Fsub.example.com`

**注意**：订阅地址可能需要编码，如果`cipher`有多个密钥，以`,`分隔，`且必须每个都有效才行!!!`

### 数据库表结构说明

#### `groups` 表

用途：操作分组相关信息。

| 字段       | 类型    | 默认值      | 描述                                                                                                                                                                                                                                       |
|----------|---------|-------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| cipher   | TEXT    |             | 支持的密钥<br/>可多个，以`,`分隔，不填则都支持。                                                                                                                                                                                                             |
| source   | TEXT    |             | 支持的来源<br/>可以填写 `surge`、`clash`<br/>如果不填则适用于所有来源。                                                                                                                                                                                         |
| priority | INTEGER | 0           | 排序字段，正序排列<br/>优先级越低越先执行<br/>0 表示最先执行。                                                                                                                                                                                                    |
| index    | INTEGER | 0           | 插入的索引位置<br/>0 表示最末尾<br/>1 表示第一位。                                                                                                                                                                                                         |
| action   | TEXT    | 'must add'  | 操作类型<br/>`must add`：必须添加，如果`value`不存在则等同于`set`操作<br/>`add`：添加，如果`value`不存在则忽略<br/>`set`：设置，如果不存在会创建，将`value`的值设置为`proxies`中的值<br/>`remove`：删除，<br/>如果没有`proxies`值，会删除组名为`value`以及组内为`value`的<br/>如果存在`proxies`，则只会删除`value`组内的`proxies`值 |
| value    | TEXT    |             | 组名<br/>可多个，以`,`分隔<br/>`*`表示所有<br/>`-`表示排除，需要排除的每个元素前都要加上-<br/>例如：`*, -🚀 节点选择` 表示除了`🚀 节点选择`以外的所有组                                                                                                                                                       |
| proxies  | TEXT    |             | 相关代理信息，可以为节点名，或者组名<br/>当为组名时，不存在不会创建，即使`action` 为 `must add`<br/>可多个，以`,`分隔<br/>`*`表示所有<br/>`-`表示排除，需要排除的每个元素前都要加上-<br/>                                                                                                                                 |

#### `proxies` 表

用途：操作节点相关信息。

| 字段     | 类型    | 默认值        | 描述                                                                                                                                                                                                          |
|----------|---------|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| cipher   | TEXT    |            | 支持的密钥<br/>可多个，以`,`分隔，不填则都支持。                                                                                                                                                                    |
| source   | TEXT    |            | 支持的来源，可以填写 `surge`、`clash`，如果不填则适用于所有来源。                                                                                                                                                                    |
| priority | INTEGER | 0          | 排序字段，正序排列，优先级越低越先执行，0 表示最先执行。                                                                                                                                                                               |
| index    | INTEGER | 0          | 插入的索引位置，0 表示最末尾，1 表示第一位。                                                                                                                                                                                    |
| action   | TEXT    | 'must add' | 操作类型<br/>`must add`：等同于`add`<br/>`add`：添加，如果节点名存在，会忽略<br/>`set`：`不支持`<br/>`remove`：删除，会同时将节点从所有组内移除                                                                                                         |
| value    | TEXT    |            | `add`时，值为整个节点信息，可以为surge、clash格式的，会根据来源自动转换，不支持多条！<br/>例如：<br/>`{name: 台湾, server: abc.com, port: 1111...}`<br/>或者<br/>`香港 = vmess, abc.com, 43022, username=5180cd6f-1111`<br/><br/>`remove`时，传入节点名称即可，可多个，以`,`分隔<br/>`*`表示所有<br/>`-`表示排除，需要排除的每个元素前都要加上-<br/> |

#### `rules` 表

用途：操作规则相关信息。

| 字段     | 类型    | 默认值        | 描述                                                                                       |
|----------|---------|------------|------------------------------------------------------------------------------------------|
| cipher   | TEXT    |            | 支持的密钥<br/>可多个，以`,`分隔，不填则都支持。                                                 |
| source   | TEXT    |            | 支持的来源，可以填写 `surge`、`clash`，如果不填则适用于所有来源。                                                 |
| priority | INTEGER | 0          | 排序字段，正序排列，优先级越低越先执行，0 表示最先执行。                                                            |
| index    | INTEGER | 0          | 插入的索引位置，0 表示最末尾，1 表示第一位。                                                                 |
| action   | TEXT    | 'must add' | 操作类型<br/>`must add`：等同于`add`<br/>`add`：添加，如果`value`存在则忽略<br/>`set`：`不支持`<br/>`remove`：删除 |
| value    | TEXT    |            | 值，例如：`DOMAIN,example.com,🚀 节点选择`                                                        |

#### `others` 表

用途：操作其他类型的信息。

| 字段     | 类型    | 默认值      | 描述                                                                                                                                                                         |
|----------|---------|-------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| cipher   | TEXT    |             | 支持的密钥<br/>可多个，以`,`分隔，不填则都支持。                                                                                                                                               |
| source   | TEXT    |             | 支持的来源，可以填写 `surge`、`clash`，如果不填则适用于所有来源。                                                                                                                                   |
| priority | INTEGER | 0           | 排序字段，正序排列，优先级越低越先执行，0 表示最先执行。                                                                                                                                              |
| index    | INTEGER | 0           | 插入的索引位置，0 表示最末尾，1 表示第一位。                                                                                                                                                   |
| action   | TEXT    | 'must add'  | 操作类型<br/>`must add`：必须添加，如果`field`不存在则等同于`set`操作<br/>`add`：添加，如果`field`不存在则忽略<br/>`set`：设置，如果不存在会创建，将值设置为`value`<br/>`remove`：删除，<br/>如果没有`value`值，则会删除最后一级的`field`字段<br/> |
| field    | TEXT    |             | 要操作的字段，如果有多级层级关系，用逗号分隔每一级。                                                                                                                                                 |
| value    | TEXT    |             | 值，`不支持多个值`，会将整个value当成一个元素去判断是否重复等操作                                                                                                                                         |


## 使用示例

---

### 示例 1: 创建`💬 OpenAi`组，并将除了`美国1`以外的所有节点添加进去

在`groups`表中将节点加入到组内，`must add` 模式下，`💬 OpenAi`不存在也会自动创建

| source | priority | index | action   | value         | proxies | cipher |
|--------|----------|-------|----------|---------------|---------|--------|
| <null> | 0        | 1     | must add | 💬 OpenAi    | *,-美国1  | <null> |

---


### 示例 2: 从`💬 OpenAi`中，并删除除了`美国1`、`,美国2`以外的所有节点

在`groups`表中，`*`此次表示所有节点，`-`表示排除`美国1`、`,美国2`节点，如果`proxies`没有值，将会删除`💬 OpenAi`这个组

| source | priority | index | action | value         | proxies     | cipher |
|--------|----------|-------|--------|---------------|-------------|--------|
| <null> | 0        | 1     | remove | 💬 OpenAi    | *,-美国1,-美国2 | <null> |

---


### 示例 3: 添加节点并加入到 `🚀 节点选择` 组

在`proxies`表中添加节点信息

| source | priority | index | action   | value                                                   | cipher |
|--------|----------|-------|----------|---------------------------------------------------------|--------|
| <null> | 0        | 1     | must add | {name: 台湾a, server: abc.com, port: 1111...}            | <null> |
| <null> | 1        | 2     | must add | 美国a = vmess, abc.com, 43022, username=5180cd6f-1111     | <null> |

在`groups`表中将节点加入到组内，`must add` 模式下，`🚀 节点选择`不存在也会自动创建

| source | priority | index | action   | value         | proxies      | cipher |
|--------|----------|-------|----------|---------------|--------------|--------|
| <null> | 0        | 1     | must add | 🚀 节点选择    | 台湾a, 美国a   | <null> |

---


### 示例 4: 添加节点到新建的组`📡 私有节点`中，并将这个组加入到 `🚀 节点选择` 组中

在`proxies`表中添加节点信息

| source | priority | index | action   | value                                                   | cipher |
|--------|----------|-------|----------|---------------------------------------------------------|--------|
| <null> | 0        | 1     | must add | {name: 台湾a, server: abc.com, port: 1111...}            | <null> |
| <null> | 1        | 2     | must add | 美国a = vmess, abc.com, 43022, username=5180cd6f-1111     | <null> |

在`groups`表中创建组并添加到 `🚀 节点选择` 组

| source | priority | index | action   | value         | proxies      | cipher |
|--------|----------|-------|----------|---------------|--------------|--------|
| <null> | 1        | 0     | must add | 📡 私有节点    | 台湾a, 美国a   | <null> |
| <null> | 2        | 1     | must add | 🚀 节点选择    | 📡 私有节点   | <null> |

---

### 示例 5: 在所有的组中，加入节点`台湾a`和组`📡 私有节点`

在`groups`表，此时`*`则表示所有的组，也可以使用`-`来排除某个组

| source | priority | index | action   | value | proxies | cipher |
|--------|----------|-------|----------|-------|---------|--------|
| <null> | 2        | 1     | must add | *     | 台湾a,📡 私有节点    | <null> |

---


### 示例 6: 删除节点`美国1`

在`proxies`表中添加节点信息，会删除当前节点，并且也会从所有组里面删除当前节点

| source | priority | index | action | value | cipher |
|--------|----------|-------|--------|-------|--------|
| <null> | 0        | 1     | remove | 美国1   | <null> |

---


### 示例 7: 指定`generativelanguage.googleapis.com`域名走 `📡 私有节点`组

在`rules`表添加规则

| source | priority | index | action   | value                                      | cipher |
|--------|----------|-------|----------|--------------------------------------------|--------|
| <null> | 0        | 1     | must add | DOMAIN,generativelanguage.googleapis.com,📡 私有节点 | <null> |


如果不存在当前组，则在`groups`表中创建当前组，`*`则表示添加所有的节点到当前组内

| source | priority | index | action   | value         | proxies | cipher |
|--------|----------|-------|----------|---------------|---------|--------|
| <null> | 0        | 1     | must add | 📡 私有节点    | *       | <null> |

---


### 示例 8: 在 `Surge` 配置中，添加跳过代理

在`others`表中，此时会先找到分组`General`，其次找到`skip-proxy`字段，将`value`添加到`index`的位置，此次加载最末尾

| source | priority | index | action   | field            | value              | cipher |
|--------|----------|-------|----------|------------------|--------------------|--------|
| surge  | 0        | 0     | must add | General,skip-proxy | *.dev.com, *.test.com | <null> |

---


### 示例 9: 在 `Surge` 配置中，替换MITM的主机名

在`others`表中，此时会先找到分组`MITM`，其次找到`hostname`字段，将`hostname`的值设置为`*:0`

| source | priority | index | action | field           | value              | cipher |
|--------|----------|-------|--------|-----------------|--------------------|--------|
| surge  | 0        | 0     | set    | MITM,hostname | *:0	 | <null> |

---


### 示例 10: 在 `Clash` 配置中，替换日志级别

在`others`表中，此时会先找到`log-level`，将`log-level`的值设置为`warn`

| source | priority | index | action | field           | value | cipher |
|--------|----------|-------|--------|-----------------|-------|--------|
| surge  | 0        | 0     | set    | log-level | warn	 | <null> |

---


### 示例 11: 在 `Clash` 配置中，删除`allow-lan`字段

在`others`表中，此时会先找到`allow-lan`，删除当前字段

| source | priority | index | action | field           | value | cipher |
|--------|----------|-------|--------|-----------------|-------|--------|
| surge  | 0        | 0     | remove | allow-lan | <null>	 | <null> |

---



## 常见问题（FAQ）

### 1. 报错: An error occurred: Cannot read properties of undefined (reading 'map')
- **解决方案**: 订阅地址需要编码。

### 2. Invalid cipher
- **解决方案**: 检查密钥是否正确，或者密钥中是否含有 `&` 或 `,`，这可能导致验证失败。

### 3. Surge 从 URL 安装配置后没有反应
- **解决方案**: 新建一个空配置，然后在网页上打开你部署后的订阅地址，将内容复制到配置中。之后可以直接更新配置。

### 4. 节点转换后无法正常使用
- **解决方案**: 建议指定 `source`，并填入对应格式的节点信息。

