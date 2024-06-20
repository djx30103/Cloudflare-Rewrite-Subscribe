const CIPHER_LIST = [
    "xxx1",
    "xxx2"
]

const FIELD = {
    SOURCE_CLASH: "clash",
    SOURCE_SURGE: "surge",
    GROUP: "GROUP",
    PROXY: "PROXY",
    RULE: "RULE",

    CLASH: {
        GROUP: "proxy-groups",
        PROXY: "proxies",
        RULE: "rules",
    },
    SURGE: {
        GROUP: "Proxy Group",
        PROXY: "Proxy",
        RULE: "Rule",
    },

    GetField(source, field) {
        if (source === this.SOURCE_CLASH) {
            return this.CLASH[field]
        }

        return this.SURGE[field]
    }
}

const ACTION = {
    MUST_ADD: "must add",
    ADD: "add",
    REMOVE: "remove",
    SET: "set"
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        const configUrl = url.searchParams.get('config'); // 从查询字符串获取订阅链接
        const configType = url.searchParams.get('source'); // 获取配置类型
        const cipher = url.searchParams.get("cipher"); // 获取密钥

        const cipherList = SplitAndTrim(cipher)
        if (CIPHER_LIST.length > 0) {
            if (cipherList.length === 0) {
                return new Response("Invalid cipher", { status: 403 });
            }

            for (let i = 0; i < cipherList.length; i++) {
                if (!CIPHER_LIST.includes(cipherList[i])) {
                    return new Response("Invalid cipher", { status: 403 });
                }
            }
        }

        if (!CIPHER_LIST.includes(cipher)) {
            return new Response("Invalid cipher", { status: 403 });
        }

        if (!configType) {
            throw new Error('Missing source parameter');
        }

        if (!configUrl) {
            throw new Error('Missing config URL parameter');
        }

        try {
            // 1. 从外部传入的订阅链接中获取初始的配置
            const configResponse = await fetch(configUrl, {
                headers: {
                    'User-Agent': 'ConfigFetcher'
                }
            });
            if (!configResponse.ok) {
                throw new Error('Failed to fetch config');
            }
            let configText = await configResponse.text();

            let cfg;
            switch (configType) {
                case FIELD.SOURCE_SURGE:
                    cfg = new SurgeConfig(configText)
                    break
                case FIELD.SOURCE_CLASH:
                    cfg = new ClashConfig(configText)
                    break
                default:
                    throw new Error("Invalid source parameter")
            }

            // 节点
            const proxyResults = await env.DB.prepare('SELECT * FROM proxies WHERE source IS NULL OR source = ? ORDER BY priority').bind(configType).all();
            console.log(`proxyResults: `, proxyResults)
            if (proxyResults && proxyResults.results) {
                RewriteProxy(cfg, FilterCipher(proxyResults.results))
            }

            // 规则
            const ruleResults = await env.DB.prepare('SELECT * FROM rules WHERE source IS NULL OR source = ? ORDER BY priority').bind(configType).all();
            console.log(`ruleResults: `, ruleResults)
            if (ruleResults && ruleResults.results) {
                RewriteRule(cfg, FilterCipher(ruleResults.results))
            }

            // 组
            const groupResults = await env.DB.prepare('SELECT * FROM groups WHERE source IS NULL OR source = ? ORDER BY priority').bind(configType).all();
            console.log(`groupResults: `, groupResults)
            if (groupResults && groupResults.results) {
                RewriteGroup(cfg, FilterCipher(groupResults.results))
            }

            // 获取其他设置
            const othersResults = await env.DB.prepare('SELECT * FROM others WHERE source IS NULL OR source = ? ORDER BY priority').bind(configType).all();
            console.log(`othersResults: `, othersResults)
            if (othersResults && othersResults.results) {
                RewriteOthers(cfg, FilterCipher(othersResults.results))
            }

            configText = cfg.ToString(request.url)

            // 最后向请求方响应修改后的配置文件
            return new Response(configText, {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                }
            });
        } catch (error) {
            return new Response('An error occurred: ' + error.message, { status: 500 });
        }
    }
}

function FilterCipher(list, cipherList) {
    const cipherSet = new Set(cipherList);

    return list.filter(item => {
        const clist = SplitAndTrim(item.cipher);
        return clist.every(cipher => cipherSet.has(cipher));
    });
}

function GetListByValue(str, allList) {
    // 所有要添加的组
    let valueList = [];
    SplitAndTrim(str).forEach(v => {
        if (v === "*") {
            AddToArray(valueList, allList)
        } else if (v.startsWith("-")) {
            valueList = valueList.filter(name => name !== v.slice(1).trim())
        } else {
            AddToArray(valueList, v)
        }
    })

    return valueList
}

// 添加组的公共方法
function commonAddGroup(cfg, groupList, item, keyOrName, valueKey) {

    // 所有要添加的组
    const groupNameList = GetListByValue(item.value, cfg.LoadGroupNames())
    // 组内的节点
    const proxyNameList = GetListByValue(item.proxies, cfg.LoadProxyNames())

    groupNameList.forEach(groupName => {
        // 检查组是否存在
        let group = groupList.find(group => group[keyOrName] === groupName);
        if (!group) {
            // 如果不是must add，则忽略
            if (item.action !== ACTION.MUST_ADD) {
                console.log(`${item.action} Group ${groupName} not found, skipping`);
                return
            }

            // 添加组及节点
            AddToArray(groupList, { [keyOrName]: groupName, type: 'select', [valueKey]: proxyNameList })
            return;
        }

        // 存在则直接添加节点
        AddToArray(group[valueKey], proxyNameList, item.index)
    })
}

// 设置组的公共方法
function commonSetGroup(cfg, groupList, item, keyOrName, valueKey) {
    // 所有要添加的组
    const groupNameList = GetListByValue(item.value, cfg.LoadGroupNames())
    // 组内的节点
    const proxyNameList = GetListByValue(item.proxies, cfg.LoadProxyNames())

    groupNameList.forEach(groupName => {
        // 检查组是否存在
        let group = groupList.find(group => group[keyOrName] === groupName);
        if (!group) {
            group = { [keyOrName]: groupName, type: 'select', [valueKey]: proxyNameList }
            AddToArray(groupList, group, item.index)
            return
        }

        group[valueKey] = proxyNameList
    })
}

// 删除组的公共方法
function commonRemoveGroup(cfg, groupList, item, keyOrName, valueKey) {
    // 所有要删除的组
    const groupNameList = GetListByValue(item.value, cfg.LoadGroupNames())

    // 组内要删除的节点
    const proxyNameList = GetListByValue(item.proxies, cfg.LoadProxyNames())

    for (let i = groupList.length - 1; i >= 0; i--) {
        const group = groupList[i];

        // 如果没有指定删除节点，则删除当前组，并要从其他组内删除当前组
        if (proxyNameList.length === 0) {
            if (groupNameList.includes(group[keyOrName])) {
                // 删除符合条件的组
                groupList.splice(i, 1);
                continue
            }
            // 删除其他组中包含当前组名的名字
            group[valueKey] = group[valueKey].filter(proxy => !groupNameList.includes(proxy));
            continue
        }

        // 否则只删除当前组中的
        if (!groupNameList.includes(group[keyOrName])) {
            continue
        }
        group[valueKey] = group[valueKey].filter(proxy => !proxyNameList.includes(proxy));
    }
}

// 添加节点的公共方法
function commonAddProxy(cfg, proxyList, item) {
    // 节点名称
    const proxyName = cfg.ExtractProxyName(item.value)
    // 节点名字已存在的话，则忽略
    if (proxyList.findIndex(proxy => proxyName === cfg.ExtractProxyName(proxy)) !== -1) {
        console.log(`节点 ${proxyName} 已存在，忽略添加`)
        return;
    }

    AddToArray(proxyList, item.value, item.index)
}

// 删除节点的公共方法
function commonRemoveProxy(cfg, groupList, proxyList, item) {
    // 组内要删除的节点
    const proxyNameList = GetListByValue(item.value, cfg.LoadProxyNames())

    // 从节点列表中删除当前节点
    for (let i = proxyList.length - 1; i >= 0; i--) {
        if (proxyNameList.includes(cfg.ExtractProxyName(proxyList[i]))) {
            proxyList.splice(i, 1);
        }
    }

    // 从组中移除当前节点
    cfg.RemoveGroup(groupList, {value: "*", proxies: item.value})
}

// clash str: { name: "IEPL-英国2", type: vmess, server: abc.cc, port: 32110, uuid: C30CD0A2-1111-2222-3333-007F91A90D34, alterId: 0, cipher: auto, network: tcp}
// surge str: IEPL-英国1 = vmess, abc.cc, 32004, username=C30CD0A2-1111-2222-3333-007F91A90D34, tls=false, ws=false, ws=false, tls13=true, skip-cert-verify=false,
function RewriteProxy(cfg, list) {
    const proxyList = cfg.Sections[FIELD.GetField(cfg.SOURCE, FIELD.PROXY)]
    const groupList = cfg.Sections[FIELD.GetField(cfg.SOURCE, FIELD.GROUP)]

    list.forEach(item => {

        // 去除开头和结尾的空格
        item.action = item.action?.trim()
        item.index = item.index != null ? item.index - 1 : item.index
        item.value = item.value?.trim()

        if (!item.value) {
            console.log(`RewriteProxy value is empty, skip`);
            return;
        }

        // 配置转换，转为对应的节点信息
        item.value = cfg.ConvertProxy(item.value)

        switch (item.action) {
            case ACTION.MUST_ADD:
            case ACTION.ADD:
                cfg.AddProxy(proxyList, item)
                break

            case ACTION.REMOVE:
                cfg.RemoveProxy(groupList, proxyList, item)
                break

            case ACTION.SET: // 暂不支持set
            default:
                throw new Error('Invalid mode');
        }

    })
}

// clash str: DOMAIN-SUFFIX,ip6-localhost,🎯 全球直连
// surge str: RULE-SET,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list,🎯 全球直连
function RewriteRule(cfg, list) {
    const ruleList = cfg.Sections[FIELD.GetField(cfg.SOURCE, FIELD.RULE)]

    list.forEach(item => {

        // 去除开头和结尾的空格
        item.action = item.action?.trim()
        item.index = item.index != null ? item.index - 1 : item.index
        item.value = item.value?.trim()

        const rlist = SplitAndTrim(item.value)
        if (rlist.length !== 3) {
            console.log(`RewriteRule 'value' format error, skip, value = ${item.value}`);
            return;
        }

        switch (item.action) {
            case ACTION.MUST_ADD:
            case ACTION.ADD:
                AddToArray(ruleList, item.value, item.index)
                // commonAddRule(cfg, groupList, ruleList, item)
                break

            case ACTION.REMOVE:
                RemoveFromArray(ruleList, item.value)
                break
            case ACTION.SET: // 暂不支持set
            default:
                throw new Error('Invalid mode');
        }
    })
}

// clash obj =  {name: "♻️ 自动选择", type: "url-test", proxies: Array(220), url: "http://abc.com", interval: 300, proxies: Array(222)}
// surge obj = {key: "♻️ 自动选择", value: Array(223)}
function RewriteGroup(cfg, list) {
    const groupList = cfg.Sections[FIELD.GetField(cfg.SOURCE, FIELD.GROUP)]

    list.forEach(item => {
        // 去除开头和结尾的空格
        item.action = item.action?.trim()
        item.index = item.index != null ? item.index - 1 : item.index
        item.value = item.value?.trim()
        item.proxies = item.proxies?.trim()

        // surge 需要+1
        if (cfg.SOURCE === FIELD.SOURCE_SURGE && item.index !== -1) {
            item.index ++
        }

        if (!item.value) {
            console.log(`RewriteGroup value is empty, skip`);
            return;
        }

        switch (item.action) {
            case ACTION.MUST_ADD:
            case ACTION.ADD:
                cfg.AddGroup(groupList, item)
                break

            case ACTION.REMOVE:
                cfg.RemoveGroup(groupList, item)
                break

            case ACTION.SET: // 暂不支持set
                cfg.SetGroup(groupList, item)
                break
            default:
                throw new Error('Invalid mode');
        }
    })
}

// clash str = DOMAIN-SUFFIX,ip6-localhost,🎯 全球直连
// surge str = RULE-SET,https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list,🎯 全球直连
function RewriteOthers(cfg, list) {

    list.forEach(item => {

        // 去除开头和结尾的空格
        item.action = item.action?.trim()
        item.index = item.index != null ? item.index - 1 : item.index
        item.field = item.field?.trim()
        item.value = item.value?.trim()

        if (!item.field) {
            console.log(`RewriteOthers field is empty, skip`);
            return;
        }

        if (!item.value && item.action !== ACTION.REMOVE) {
            console.log(`RewriteOthers value is empty, skip`);
            return;
        }

        switch (item.action) {
            case ACTION.MUST_ADD:
            case ACTION.ADD:
                cfg.AddOthers(item)
                break

            case ACTION.REMOVE:
                cfg.RemoveOthers(item)
                break

            case ACTION.SET:
                cfg.SetOthers(item)
                break

            default:
                throw new Error('Invalid mode');
        }

    })
}

// SurgeConfig 配置
class SurgeConfig {
    constructor(configString) {
        this.Sections = this.parseConfig(configString);
        this.SOURCE = FIELD.SOURCE_SURGE
        this.MustProxyNames = ['select', 'REJECT', 'DIRECT']
        console.log("parseSurgeConfig: ", this.Sections)
    }

    parseConfig(configString) {
        const lines = configString.split('\n');
        const sections = {};
        let currentSection = null;

        const isSpecialSection = function (currentSection) {
            // 检查该行是否属于特殊部分，例如 URL 重写、脚本、规则等。
            const specialSections = ['URL Rewrite', 'Script', 'Rule', 'Proxy'];
            for (let section of specialSections) {
                if (currentSection === section) {
                    return true;
                }
            }

            return false
        }

        const parseKeyValue = function (currentSection, line) {
            const index = line.indexOf("=");
            if (index !== -1 && !isSpecialSection(currentSection)) {
                const key = line.substring(0, index).trim();
                const value = line.substring(index + 1).trim();

                return { key, value: SplitAndTrim(value) };
            }

            return line;
        }

        lines.forEach(line => {
            line = line.trim();
            if (line.startsWith('[') && line.endsWith(']')) {
                currentSection = line.slice(1, -1);
                sections[currentSection] = [];
            } else if (currentSection) {
                if (line) { // Only add non-empty lines
                    sections[currentSection].push(parseKeyValue(currentSection, line));
                }
            }
        });

        return sections;
    }

    // 将clash的订阅字符串转为surge的
    ConvertProxy(proxyStr) {
        // 如果不是clash的，则忽略
        if (!proxyStr.startsWith("{")) {
            return proxyStr
        }

        const clashProxy = parseClashProxy(proxyStr)

        const surgeProxy = {};

        surgeProxy.name = clashProxy.name;
        surgeProxy.type = clashProxy.type;
        surgeProxy.server = clashProxy.server;
        surgeProxy.servername = clashProxy.servername
        surgeProxy.port = clashProxy.port;
        surgeProxy.password = clashProxy.password;
        surgeProxy.username = clashProxy.uuid;
        surgeProxy.udp = clashProxy["udp-relay"];
        surgeProxy.tls = clashProxy.tls;
        surgeProxy.udp = clashProxy["udp-relay"];
        surgeProxy["encrypt-method"] = (clashProxy.cipher && clashProxy.cipher !== "auto") || undefined

        // ws-headers: { Host: abc.com }
        // ws-opts: {path: /bcfba0ba-1234-5678-2468-a8a062d0e2aa, headers: {Host: abc.com}}
        const wsOpts = clashProxy["ws-opts"];
        surgeProxy["ws-path"] = clashProxy["ws-path"] || (wsOpts && wsOpts["path"]);
        surgeProxy["ws-headers"] = clashProxy["ws-headers"] || (wsOpts && wsOpts["headers"]);
        if (surgeProxy["ws-path"] || surgeProxy["ws-headers"]) {
            if (surgeProxy.type === "vmess") {
                surgeProxy["vmess-aead"] = true;
            }
        }

        if (clashProxy.network === "ws") {
            surgeProxy.ws = true;
        }

        surgeProxy.sni = clashProxy.sni

        surgeProxy["skip-cert-verify"] = clashProxy["skip-cert-verify"]

        console.log("clashToSurgeProxy:", surgeProxy)

        return unparseSurgeProxy(surgeProxy);
    }

    // 从节点字符串中提取节点名字
    ExtractProxyName(proxy) {
        // 找到等号的位置
        const equalIndex = proxy.indexOf('=');
        // 获取等号左边的部分并去除前后的空格
        return proxy.substring(0, equalIndex).trim();
    }

    LoadGroupNames() {
        return this.Sections[FIELD.SURGE.GROUP].map(line => line.key);
    }

    // 获取当前所有的节点名字
    LoadProxyNames() {
        const proxyNames = this.Sections[FIELD.SURGE.PROXY].map(line => this.ExtractProxyName(line));
        return [...new Set([...this.MustProxyNames, ...proxyNames])];
    }

    // 添加组，会根据item.action来判断是否为must add

    AddGroup(groupList, item) { commonAddGroup(this, groupList, item, 'key', 'value'); }

    RemoveGroup(groupList, item) { commonRemoveGroup(this, groupList, item, 'key', 'value'); }

    SetGroup(groupList, item) { commonSetGroup(this, groupList, item, 'key', 'value'); }

    AddProxy(proxyList, item) { commonAddProxy(this, proxyList, item); }

    RemoveProxy(groupList, proxyList, item) { commonRemoveProxy(this, groupList, proxyList, item); }

    SetOthers(item) {
        const fieldList = SplitAndTrim(item.field);

        let list = this.Sections[fieldList[0]]
        for (let i = 1; i < fieldList.length; i++) {
            const key = fieldList[i]
            // 如果当前层不存在则创建
            let idx = list.findIndex(arr => arr.key === key)
            if (idx === -1) {
                if (!list) {
                    list = []
                }
                AddToArray(list, { key: key, value: []})
                idx = list.length - 1
            } else {
                if (!Array.isArray(list)) {
                    throw new Error(`Expected acc[${key}] to be an array`);
                }
            }

            list = list[idx].value
        }

        if (!list) {
            list = []
        }

        // 清空数组并设置
        list.splice(0, list.length, item.value)
    }

    AddOthers(item) {
        const fieldList = SplitAndTrim(item.field);

        let list = this.Sections[fieldList[0]]
        for (let i = 1; i < fieldList.length; i++) {
            const key = fieldList[i]
            // 如果当前层不存在则创建
            let idx = list.findIndex(arr => arr.key === key)
            if (idx === -1) {
                if (item.action !== ACTION.MUST_ADD) {
                    console.log(`[${item.action}] ${key} not found, ignored`)
                    return;
                }

                if (!list) {
                    list = []
                }

                AddToArray(list, { key: key, value: []})
                idx = list.length - 1
            } else {
                if (!Array.isArray(list)) {
                    throw new Error(`[${item.action}] ${key} not an array`);
                }
            }

            list = list[idx].value
        }

        if (!list) {
            if (item.action !== ACTION.MUST_ADD) {
                console.log(`[${item.action}] ${fieldList} not found, ignored`)
                return;
            }
            list = []
        } else {
            // 效验是否已存在
            if (list.includes(item.value)) {
                console.log(`[${item.action}] ${item.value} already exists, ignored`)
                return;
            }
        }

        // 添加到数组中
        AddToArray(list, item.value, item.index)
    }

    RemoveOthers(item) {
        const fieldList = SplitAndTrim(item.field);

        let list = this.Sections[fieldList[0]]
        for (let i = 1; i < fieldList.length - 1; i++) {
            const key = fieldList[i]
            // 如果当前层不存在则创建
            let idx = list.findIndex(arr => arr.key === key)
            if (idx === -1) {
                console.log(`[${item.action}] ${key} not found, ignored`)
                return;
            }

            if (!Array.isArray(list)) {
                throw new Error(`Expected acc[${key}] to be an array`);
            }

            list = list[idx].value
        }

        if (!list) {
            console.log(`[${item.action}] ${fieldList} not found, ignored`)
            return;
        }

        const idx = list.findIndex(arr => arr.key === fieldList[fieldList.length - 1])
        if (idx === -1) {
            console.log(`[${item.action}] ${fieldList} not found, ignored`)
            return;
        }

        const vlist = list[idx].value
        // 没有值就删除最后一个field
        if (!item.value) {
            list.splice(idx, 1)
            return;
        }

        if (!vlist) {
            console.log(`[${item.action}] ${fieldList} not found, ignored`)
            return;
        }

        // 删除元素中所有的值
        if (item.value === '*') {
            vlist.splice(0, vlist.length)
            return;
        }

        // 删除value值
        for (let i = 0; i < vlist.length; i++) {
            if (vlist[i] === item.value) {
                vlist.splice(i, 1)
                i--
            }
        }

    }

    // 将SurgeConfig 转换为字符串
    ToString(requestUrl) {

        const moveSelectToFirst = function (arr) {
            let index = arr.indexOf('select') !== -1 ? arr.indexOf('select') : arr.indexOf('url-test');
            if (index !== -1) {
                // 移除元素
                arr.splice(index, 1);
                // 添加到开头
                arr.unshift('select');
            } else {
                AddToArray(arr, 'select', 0)
            }
        }

        let result = `#!MANAGED-CONFIG ${requestUrl}\n`

        for (const section in this.Sections) {
            result += `\n[${section}]\n`;
            this.Sections[section].forEach(line => {
                if (section === FIELD.SURGE.GROUP) {
                    moveSelectToFirst(line.value)
                }

                if (typeof line === 'string') {
                    result += `${line}\n`;
                }else {
                    result += `${line.key} = ${line.value.join(', ')}\n`;
                }
            });
        }
        return result.trim();
    }
}

class ClashConfig {
    constructor(configString) {
        this.SOURCE = FIELD.SOURCE_CLASH
        this.Sections = this.parseConfig(configString);

        this.MustProxyNames = ['REJECT', 'DIRECT']
        console.log("parseClashConfig:", this.Sections)
    }

    // 解析Clash配置
    parseConfig(configText) {

        let res = YAML.eval(configText);

        const parseProxies = function (configText) {
            // 查找 proxies 部分的起始位置
            const proxiesStartIndex1 = configText.indexOf("proxies:");

            if (proxiesStartIndex1 === -1) {
                throw new Error('Invalid Clash config: "proxies" section not found');
            }

            // 查找 proxies 部分的结束位置
            const nextSectionMatch = configText.substring(proxiesStartIndex1).match(/\n[a-zA-Z-]+:/);
            const proxiesEndIndex = nextSectionMatch ? proxiesStartIndex1 + nextSectionMatch.index : configText.length;

            // 确保截取到完整的 proxies 部分内容
            const proxiesSection = configText.substring(proxiesStartIndex1, proxiesEndIndex);

            // 去掉所有缩进和前导空白
            const cleanedProxiesSection = proxiesSection.replace(/^\s+/gm, '');

            // 分割输入字符串为行数组
            const lines = cleanedProxiesSection.trim().split('\n');

            // 去掉 'proxies:' 行并解析每行去掉开头的 '-'
            return lines
                .filter(line => !line.trim().startsWith('proxies:'))
                .map(line => line.trim().substring(2));
        };

        const parseRules = function (configText){
            // 匹配 rules: 部分并捕获前导空格
            const rulesSectionRegex = /^(\s*)rules:\s*\n/gm;
            const match = rulesSectionRegex.exec(configText);
            if (!match) {
                throw new Error('Invalid config format: "rules" section not found');
            }

            // 提取 rules: 后面的部分
            const remainingText = configText.slice(match.index + match[0].length);

            // 删除现有规则缩进
            const cleanedRemainingText = remainingText.replace(/^(\s*)- /gm, '- ');
            return cleanedRemainingText.split('\n')
                .map(rule => rule.trim())
                .filter(rule => rule.length > 0 && !rule.startsWith('#')) // 只保留非空且不以 "#" 开头的行
                .map(rule => rule.replace(/^- /, '')); // 去掉前缀 "- "
        };

        const parseProxyGroups = function (configText) {
            // 匹配 proxy-groups 部分的正则表达式
            const proxyGroupsSectionRegex = /(\n\s*proxy-groups:\s*\n)([\s\S]*?)(?=\n\S|$)/;
            const proxyGroupsMatch = proxyGroupsSectionRegex.exec(configText);

            if (!proxyGroupsMatch) {
                throw new Error('Invalid Clash config: "proxy-groups" section not found');
            }

            const proxyGroupsSection = proxyGroupsMatch[2];
            const proxyGroups = [];
            const groupRegex = /- name:\s*(.*?)\n\s*type:\s*(.*?)\n\s*(?:url:\s*(.*?)\n\s*interval:\s*(\d+)\n\s*tolerance:\s*(\d+)\n\s*)?proxies:\s*\n([\s\S]*?)(?=\n\s*-\s*name:|\n\s*$)/g;
            let match;

            while ((match = groupRegex.exec(proxyGroupsSection)) !== null) {
                const name = match[1].trim();
                const type = match[2].trim();
                const url = match[3] ? match[3].trim() : null;
                const interval = match[4] ? parseInt(match[4].trim()) : null;
                const tolerance = match[5] ? parseInt(match[5].trim()) : null;
                const proxies = match[6].split('\n')
                    .map(proxy => proxy.trim().replace(/^- /, ''))
                    .filter(proxy => proxy);

                const group = { name, type, proxies };
                if (url) group.url = url;
                if (interval !== null) group.interval = interval;
                if (tolerance !== null) group.tolerance = tolerance;

                proxyGroups.push(group);
            }

            return proxyGroups;
        };

        res[FIELD.CLASH.PROXY] = parseProxies(configText)
        res[FIELD.CLASH.GROUP] = parseProxyGroups(configText)
        res[FIELD.CLASH.RULE] = parseRules(configText)

        return res
    }

    // 将surge的订阅字符串转为clash的
    ConvertProxy(proxyStr) {

        // 如果是clash的，则忽略
        if (proxyStr.startsWith("{")) {
            return proxyStr
        }

        const surgeProxy = parseSurgeProxy(proxyStr)
        const clashProxy = {};

        clashProxy.name = surgeProxy.name;
        clashProxy.type = surgeProxy.type;
        if (clashProxy.type !== "ss") {
            clashProxy.network = "tcp";
            clashProxy.alterId = 0;
        }
        clashProxy.server = surgeProxy.server;
        clashProxy.servername = surgeProxy.servername
        clashProxy.port = surgeProxy.port;
        clashProxy.password = surgeProxy.password;
        clashProxy.uuid = surgeProxy.username;
        clashProxy.tls = surgeProxy.tls;
        clashProxy["udp-relay"] = surgeProxy.udp;
        clashProxy.cipher = surgeProxy["encrypt-method"] || "auto";
        if (surgeProxy["ws-path"] || surgeProxy["ws-headers"]) {
            clashProxy["ws-opts"] = {"path": surgeProxy["ws-path"], "headers": surgeProxy["ws-headers"]}
        }
        clashProxy["skip-cert-verify"] = surgeProxy["skip-cert-verify"]
        clashProxy.sni = surgeProxy.sni;
        if (surgeProxy.ws) {
            clashProxy.network = "ws"
        }

        console.log("surgeToClashProxy:", clashProxy)

        return unparseClashProxy(clashProxy);
    }

    // 从节点字符串中提取节点名字
    ExtractProxyName(proxy) {

        if (typeof proxy === 'object') {
            return proxy.name
        }

        const nameMatch = proxy.match(/name:\s*["']?([^,"'}]*)["']?/)
        if (!nameMatch) {
            throw new Error('Invalid Node Data: "name" not found');
        }

        return nameMatch[1].trim()
    }

    LoadGroupNames() {
        return this.Sections[FIELD.CLASH.GROUP].map(line => line.name);
    }

    // 获取所有节点名字
    LoadProxyNames() {
        const proxyNames = this.Sections[FIELD.CLASH.PROXY].map(line => this.ExtractProxyName(line));
        return [...new Set([...this.MustProxyNames, ...proxyNames])];
    }

    AddGroup(groupList, item) { commonAddGroup(this, groupList, item, 'name', 'proxies'); }

    RemoveGroup(groupList, item) { commonRemoveGroup(this, groupList, item, 'name', 'proxies'); }

    SetGroup(groupList, item) { commonSetGroup(this, groupList, item, 'name', 'proxies');}

    AddProxy(groupList, proxyList, item) { commonAddProxy(this, groupList, proxyList, item, 'name', 'proxies'); }

    RemoveProxy(groupList, proxyList, item) { commonRemoveProxy(this, groupList, proxyList, item, 'name', 'proxies'); }

    SetOthers(item) {
        const fieldList = SplitAndTrim(item.field);
        const lastIndex = fieldList.length - 1

        let obj = this.Sections
        for (let i = 0; i < lastIndex; i++) {
            const key = fieldList[i]

            // 如果当前层不存在则创建
            obj[key] ??= {}

            // 检查 acc[key] 是否为对象，最后一个key时跳过
            if (typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
                throw new Error(`Expected acc[${key}] to be an object`);
            }

            obj = obj[key]
        }

        // 将最后一个字段的值设置为 item.value
        obj[fieldList[lastIndex]] = item.value;
    }

    AddOthers(item) {
        const fieldList = SplitAndTrim(item.field);
        const lastIndex = fieldList.length - 1;

        const isMustAdd = item.action === ACTION.MUST_ADD;

        let obj = this.Sections
        for (let i = 0; i < lastIndex; i++) {
            const key = fieldList[i]
            if (!obj[key]) {

                if (!isMustAdd) {
                    console.log("add others: " + item.field + " not found, skip")
                    return;
                }

                obj[key] = {}
            }

            // 检查 acc[key] 是否为对象，最后一个key时跳过
            if (typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
                throw new Error(`Expected acc[${key}] to be an object`);
            }

            obj = obj[key]
        }

        if (!obj) {
            throw new Error(`Expected acc[${fieldList[lastIndex]}] to be an object`);
        }


        let modifiedList;
        let isArray = false;

        const lastList = obj[fieldList[lastIndex]];
        if (!lastList) {
            if (!isMustAdd) {
                console.log("add others: " + item.field + " not found, skip")
                return;
            }
            modifiedList = []
            isArray = true
        } else {
            isArray = Array.isArray(lastList)
            if (!isArray) {
                // 不是数组则转为数组
                modifiedList = SplitAndTrim(lastList.toString())
            } else {
                modifiedList = [...lastList]
            }
        }

        // 如果存在的话则忽略
        const idx = lastList.indexOf(item.value)
        if (idx !== -1) {
            console.log("add others: " + item.value + " already exists, skip")
            return
        }

        // 添加
        AddToArray(modifiedList, item.value, item.index)

        if (!isArray) {
            // 如果原本不是数组，则将修改后的数组转回字符串
            obj[fieldList[lastIndex]] = modifiedList.join(', '); // 这里的 join 方法可以根据需要调整分隔符
        } else {
            // 如果原本就是数组，则直接赋值回去
            obj[fieldList[lastIndex]] = modifiedList;
        }
    }

    RemoveOthers(item) {
        const fieldList = SplitAndTrim(item.field);
        const lastIndex = fieldList.length - 1;

        let obj = this.Sections
        for (let i = 0; i < lastIndex; i++) {
            const key = fieldList[i]
            if (!obj[key]) {
                return;
            }

            // 检查 acc[key] 是否为对象，最后一个key时跳过
            if (typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
                throw new Error(`Expected acc[${key}] to be an object`);
            }

            obj = obj[key]
        }

        if (!obj) {
            console.log("delete others: " + item.field + " not found, skip")
            return
        }

        if (!item.value) {
            // 没有值就删除最后一个field
            delete obj[fieldList[lastIndex]];
            return;
        }

        const lastList = obj[fieldList[lastIndex]];
        if (!lastList) {
            console.log("delete others: " + item.field + " not found, skip")
            return;
        }

        const isArray = Array.isArray(lastList)

        let modifiedList;
        if (!isArray) {
            // 不是数组则转为数组
            modifiedList = SplitAndTrim(lastList.toString())
        } else {
            modifiedList = [...lastList]
        }

        // 如果是* 则删除里面所有元素
        if (item.value === '*') {
            modifiedList.length = 0;
            return;
        }

        // 找到value后删除
        const idx = modifiedList.indexOf(item.value)
        if (idx === -1) {
            console.log("delete others: " + item.value + " not found, skip")
            return
        }

        modifiedList.splice(idx, 1);

        if (!isArray) {
            // 如果原本不是数组，则将修改后的数组转回字符串
            obj[fieldList[lastIndex]] = modifiedList.join(', '); // 这里的 join 方法可以根据需要调整分隔符
        } else {
            // 如果原本就是数组，则直接赋值回去
            obj[fieldList[lastIndex]] = modifiedList;
        }
    }

    ToString() {
        const parseValue = function (obj, indentLevel = 0) {
            const indent = '  '.repeat(indentLevel);
            let yamlStr = '';
            if (typeof obj === 'object' && obj !== null) {
                if (Array.isArray(obj)) {
                    for (const item of obj) {
                        yamlStr += `${indent}- ${parseValue(item, indentLevel + 1).trim()}\n`;
                    }
                } else {
                    for (const key in obj) {
                        if (obj.hasOwnProperty(key)) {
                            let value = obj[key];
                            if (typeof value === 'object' && value !== null) {
                                yamlStr += `${indent}${key}:\n${parseValue(value, indentLevel + 1)}`;
                            } else {
                                if (value === `*`) {
                                    value = `"*"`;
                                }
                                yamlStr += `${indent}${key}: ${value}\n`;
                            }
                        }
                    }
                }
            } else {
                yamlStr += `${indent}${obj}\n`;
            }

            return yamlStr;
        }


        return parseValue(this.Sections);
    }
}

/**
 * 向数组中添加一个或多个元素，同时避免重复的元素。
 *
 * @param {Array} arr - 要操作的目标数组。
 * @param {Array|any} elements - 要添加的元素，可以是单个元素或一个包含多个元素的数组。
 * @param {number} [idx=-1] - 可选参数，指定插入的位置。如果未提供或值为负数或超出数组长度，则默认在数组末尾插入。
 * @param {function} [compareFn=(a, b) => a === b] - 可选参数，比较函数，用于判断数组中是否已经存在某个元素。默认比较函数是使用严格相等运算符比较。
 */
function AddToArray(arr, elements, idx = -1, compareFn = (a, b) => a === b) {
    // 检查elements是否是数组
    if (!Array.isArray(elements)) {
        elements = [elements];
    }

    // 过滤掉重复的元素
    const filteredElements = elements.filter(el => {
        return !arr.some(existingEl => compareFn(existingEl, el));
    });

    // 确定插入的位置
    if (idx < 0 || idx >= arr.length) {
        arr.push(...filteredElements);
    } else {
        arr.splice(idx, 0, ...filteredElements);
    }
}

/**
 * 从数组中删除一个或多个指定的元素。
 *
 * @param {Array} arr - 要操作的目标数组。
 * @param {Array|any} elements - 要删除的元素，可以是单个元素或一个包含多个元素的数组。
 * @param {function} [compareFn=(a, b) => a === b] - 可选参数，比较函数，用于判断数组中是否包含某个元素。默认比较函数是使用严格相等运算符比较。
 */
function RemoveFromArray(arr, elements, compareFn = (a, b) => a === b) {
    // 检查elements是否是数组
    if (!Array.isArray(elements)) {
        elements = [elements];
    }

    // 过滤掉指定的元素
    elements.forEach(el => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (compareFn(arr[i], el)) {
                arr.splice(i, 1);
            }
        }
    });
}

// 拆分并去除空格
function SplitAndTrim(str, separator = ',') {
    return (typeof str === 'string' && str) ? str.split(separator).map(s => s.trim()).filter(s => s.length > 0) : [];
}

// 解析 Clash 节点字符串 -> json
function parseClashProxy(str) {
    // 去掉首尾的大括号
    str = str.trim();
    if (str.startsWith("{") && str.endsWith("}")) {
        str = str.slice(1, -1);
    }

    const obj = {};
    let i = 0;
    let key = '';
    let value = '';
    let isKey = true;
    let nestedLevel = 0;
    let nestedStr = '';

    const parseValue = function (value) {
        if (value.startsWith("{") && value.endsWith("}")) {
            return parseClashProxy(value);
        } else if (!isNaN(value)) {
            return Number(value);
        } else if (value === "true") {
            return true;
        } else if (value === "false") {
            return false;
        } else {
            return value.replace(/'/g, "").replace(/"/g, "");
        }
    }


    while (i < str.length) {
        const char = str[i];

        if (char === '{') {
            nestedLevel++;
            nestedStr += char;
        } else if (char === '}') {
            nestedLevel--;
            nestedStr += char;

            if (nestedLevel === 0) {
                value = parseClashProxy(nestedStr);
                nestedStr = '';
                isKey = true;
                obj[key.trim()] = value;
                key = '';
                value = '';
            }
        } else if (nestedLevel > 0) {
            nestedStr += char;
        } else if (char === ':' && isKey) {
            isKey = false;
        } else if (char === ',' && nestedLevel === 0) {
            isKey = true;
            obj[key.trim()] = parseValue(value.trim());
            key = '';
            value = '';
        } else {
            if (isKey) {
                key += char;
            } else {
                value += char;
            }
        }

        i++;
    }

    if (key) {
        obj[key.trim()] = parseValue(value.trim());
    }

    return obj;
}

// 将 json 转换为 Clash 节点字符串
function unparseClashProxy(obj) {
    let result = '{';


    const parseValue = function (value) {
        if (typeof value === 'object' && !Array.isArray(value)) {
            return unparseClashProxy(value);
        } else if (typeof value === 'string') {
            return value;
        } else {
            return JSON.stringify(value);
        }
    }

    const keys = Object.keys(obj);
    keys.forEach((key, index) => {
        const value = obj[key];

        if (value === undefined) {
            return
        }

        result += `${key}: ${parseValue(value)}`;
        if (index < keys.length - 1) {
            result += ', ';
        }
    });

    result += '}';
    return result;
}

// 解析surge节点
function parseSurgeProxy(str) {
    const result = {};

    // Split the input string into name and the rest of the details
    const [namePart, detailsPart] = str.split(' = ');
    result.name = namePart.trim();

    // Split the details into individual parts
    const details = detailsPart.split(',').map(item => item.trim());

    // Assign the fixed position fields
    result.type = details[0];
    result.server = details[1];
    result.port = parseInt(details[2]);

    // Parse the rest of the details
    for (let i = 3; i < details.length; i++) {
        const [key, value] = details[i].split('=');
        if (value) {
            const trimmedKey = key.trim();
            const trimmedValue = value.trim();

            // Check if the value needs to be parsed further (e.g., ws-headers=Host:abc.com)
            if (trimmedValue.includes(':')) {
                const nestedObject = {};
                const [nestedKey, nestedValue] = trimmedValue.split(':').map(item => item.trim());
                nestedObject[nestedKey] = nestedValue;
                result[trimmedKey] = nestedObject;
            } else {
                result[trimmedKey] = trimmedValue;
            }
        }
    }

    return result;
}

// 将解析的surge节点转回节点字符串
function unparseSurgeProxy(proxy) {
    let result = `${proxy.name} = ${proxy.type}, ${proxy.server}, ${proxy.port}`;

    for (const key in proxy) {
        if (key !== 'name' && key !== 'type' && key !== 'server' && key !== 'port') {
            const value = proxy[key];
            if (value === undefined) {
                continue
            }

            if (typeof value === 'object' && value !== null) {
                for (const nestedKey in value) {
                    result += `, ${key}=${nestedKey}:${value[nestedKey]}`;
                }
            } else {
                result += `, ${key}=${value}`;
            }
        }
    }

    return result;
}

var YAML =
    (function() {
        var errors = [],
            reference_blocks = [],
            regex =
                {
                    "regLevel" : new RegExp("^([\\s\\-]+)"),
                    "invalidLine" : new RegExp("^\\-\\-\\-|^\\.\\.\\.|^\\s*#.*|^\\s*$"),
                    "dashesString" : new RegExp("^\\s*\\\"([^\\\"]*)\\\"\\s*$"),
                    "quotesString" : new RegExp("^\\s*\\\'([^\\\']*)\\\'\\s*$"),
                    "float" : new RegExp("^[+-]?[0-9]+\\.[0-9]+(e[+-]?[0-9]+(\\.[0-9]+)?)?$"),
                    "integer" : new RegExp("^[+-]?[0-9]+$"),
                    "array" : new RegExp("\\[\\s*(.*)\\s*\\]"),
                    "map" : new RegExp("\\{\\s*(.*)\\s*\\}"),
                    "key_value" : new RegExp("([a-z0-9_-][ a-z0-9_-]*):( .+)", "i"),
                    "single_key_value" : new RegExp("^([a-z0-9_-][ a-z0-9_-]*):( .+?)$", "i"),
                    "key" : new RegExp("([a-z0-9_-][ a-z0-9_-]+):( .+)?", "i"),
                    "item" : new RegExp("^-\\s+"),
                    "trim" : new RegExp("^\\s+|\\s+$"),
                    "comment" : new RegExp("([^\\\'\\\"#]+([\\\'\\\"][^\\\'\\\"]*[\\\'\\\"])*)*(#.*)?")
                };

        /**
         * @class A block of lines of a given level.
         * @param {int} lvl The block's level.
         * @private
         */
        function Block(lvl) {
            return {
                /* The block's parent */
                parent: null,
                /* Number of children */
                length: 0,
                /* Block's level */
                level: lvl,
                /* Lines of code to process */
                lines: [],
                /* Blocks with greater level */
                children : [],
                /* Add a block to the children collection */
                addChild : function(obj) {
                    this.children.push(obj);
                    obj.parent = this;
                    ++this.length;
                }
            };
        }

        function parser(str) {
            var regLevel = regex["regLevel"];
            var invalidLine = regex["invalidLine"];
            var lines = str.split("\n");
            var m;
            var level = 0, curLevel = 0;

            var blocks = [];

            var result = new Block(-1);
            var currentBlock = new Block(0);
            result.addChild(currentBlock);
            var levels = [];
            var line = "";

            blocks.push(currentBlock);
            levels.push(level);

            for(var i = 0, len = lines.length; i < len; ++i) {
                line = lines[i];

                if(line.match(invalidLine)) {
                    continue;
                }

                if(m = regLevel.exec(line)) {
                    level = m[1].length;
                } else
                    level = 0;

                if(level > curLevel) {
                    var oldBlock = currentBlock;
                    currentBlock = new Block(level);
                    oldBlock.addChild(currentBlock);
                    blocks.push(currentBlock);
                    levels.push(level);
                } else if(level < curLevel) {
                    var added = false;

                    var k = levels.length - 1;
                    for(; k >= 0; --k) {
                        if(levels[k] == level) {
                            currentBlock = new Block(level);
                            blocks.push(currentBlock);
                            levels.push(level);
                            if(blocks[k].parent!= null)
                                blocks[k].parent.addChild(currentBlock);
                            added = true;
                            break;
                        }
                    }

                    if(!added) {
                        errors.push("Error: Invalid indentation at line " + i + ": " + line);
                        return;
                    }
                }

                currentBlock.lines.push(line.replace(regex["trim"], ""));
                curLevel = level;
            }

            return result;
        }

        function processValue(val) {
            val = val.replace(regex["trim"], "");
            var m = null;

            if(val == 'true') {
                return true;
            } else if(val == 'false') {
                return false;
            } else if(val == '.NaN') {
                return Number.NaN;
            } else if(val == 'null') {
                return null;
            } else if(val == '.inf') {
                return Number.POSITIVE_INFINITY;
            } else if(val == '-.inf') {
                return Number.NEGATIVE_INFINITY;
            } else if(m = val.match(regex["dashesString"])) {
                return m[1];
            } else if(m = val.match(regex["quotesString"])) {
                return m[1];
            } else if(m = val.match(regex["float"])) {
                return parseFloat(m[0]);
            } else if(m = val.match(regex["integer"])) {
                return parseInt(m[0]);
            } else if(m = val.match(regex["single_key_value"])) {
                var res = {};
                res[m[1]] = processValue(m[2]);
                return res;
            } else if(m = val.match(regex["array"])){
                var count = 0, c = ' ';
                var res = [];
                var content = "";
                var str = false;
                for(var j = 0, lenJ = m[1].length; j < lenJ; ++j) {
                    c = m[1][j];
                    if(c == '\'' || c == '"') {
                        if(str === false) {
                            str = c;
                            content += c;
                            continue;
                        } else if((c == '\'' && str == '\'') || (c == '"' && str == '"')) {
                            str = false;
                            content += c;
                            continue;
                        }
                    } else if(str === false && (c == '[' || c == '{')) {
                        ++count;
                    } else if(str === false && (c == ']' || c == '}')) {
                        --count;
                    } else if(str === false && count == 0 && c == ',') {
                        res.push(processValue(content));
                        content = "";
                        continue;
                    }

                    content += c;
                }

                if(content.length > 0)
                    res.push(processValue(content));
                return res;
            } else if(m = val.match(regex["map"])){
                var count = 0, c = ' ';
                var res = [];
                var content = "";
                var str = false;
                for(var j = 0, lenJ = m[1].length; j < lenJ; ++j) {
                    c = m[1][j];
                    if(c == '\'' || c == '"') {
                        if(str === false) {
                            str = c;
                            content += c;
                            continue;
                        } else if((c == '\'' && str == '\'') || (c == '"' && str == '"')) {
                            str = false;
                            content += c;
                            continue;
                        }
                    } else if(str === false && (c == '[' || c == '{')) {
                        ++count;
                    } else if(str === false && (c == ']' || c == '}')) {
                        --count;
                    } else if(str === false && count == 0 && c == ',') {
                        res.push(content);
                        content = "";
                        continue;
                    }

                    content += c;
                }

                if(content.length > 0)
                    res.push(content);

                var newRes = {};
                for(var j = 0, lenJ = res.length; j < lenJ; ++j) {
                    if(m = res[j].match(regex["key_value"])) {
                        newRes[m[1]] = processValue(m[2]);
                    }
                }

                return newRes;
            } else
                return val;
        }

        function processFoldedBlock(block) {
            var lines = block.lines;
            var children = block.children;
            var str = lines.join(" ");
            var chunks = [str];
            for(var i = 0, len = children.length; i < len; ++i) {
                chunks.push(processFoldedBlock(children[i]));
            }
            return chunks.join("\n");
        }

        function processLiteralBlock(block) {
            var lines = block.lines;
            var children = block.children;
            var str = lines.join("\n");
            for(var i = 0, len = children.length; i < len; ++i) {
                str += processLiteralBlock(children[i]);
            }
            return str;
        }

        function processBlock(blocks) {
            var m = null;
            var res = {};
            var lines = null;
            var children = null;
            var currentObj = null;

            var level = -1;

            var processedBlocks = [];

            var isMap = true;

            for(var j = 0, lenJ = blocks.length; j < lenJ; ++j) {

                if(level != -1 && level != blocks[j].level)
                    continue;

                processedBlocks.push(j);

                level = blocks[j].level;
                lines = blocks[j].lines;
                children = blocks[j].children;
                currentObj = null;

                for(var i = 0, len = lines.length; i < len; ++i) {
                    var line = lines[i];

                    if(m = line.match(regex["key"])) {
                        var key = m[1];

                        if(key[0] == '-') {

                            key = key.replace(regex["item"], "");

                            if (isMap) {
                                isMap = false;
                                if (typeof(res.length) === "undefined") {
                                    res = [];
                                }
                            }
                            if(currentObj != null) res.push(currentObj);
                            currentObj = {};
                            isMap = true;
                        }

                        if(typeof m[2] != "undefined") {
                            var value = m[2].replace(regex["trim"], "");
                            if(value[0] == '&') {
                                var nb = processBlock(children);
                                if(currentObj != null) currentObj[key] = nb;
                                else res[key] = nb;
                                reference_blocks[value.substr(1)] = nb;
                            } else if(value[0] == '|') {
                                if(currentObj != null) currentObj[key] = processLiteralBlock(children.shift());
                                else res[key] = processLiteralBlock(children.shift());
                            } else if(value[0] == '*') {
                                var v = value.substr(1);
                                var no = {};

                                if(typeof reference_blocks[v] == "undefined") {
                                    errors.push("Reference '" + v + "' not found!");
                                } else {
                                    for(var k in reference_blocks[v]) {
                                        no[k] = reference_blocks[v][k];
                                    }

                                    if(currentObj != null) currentObj[key] = no;
                                    else res[key] = no;
                                }
                            } else if(value[0] == '>') {
                                if(currentObj != null) currentObj[key] = processFoldedBlock(children.shift());
                                else res[key] = processFoldedBlock(children.shift());
                            } else {
                                if(currentObj != null) currentObj[key] = processValue(value);
                                else res[key] = processValue(value);
                            }
                        } else {
                            if(currentObj != null) currentObj[key] = processBlock(children);
                            else res[key] = processBlock(children);
                        }
                    } else if(line.match(/^-\s*$/)) {
                        if (isMap) {
                            isMap = false;
                            if (typeof(res.length) === "undefined") {
                                res = [];
                            }
                        }
                        if(currentObj != null) res.push(currentObj);
                        currentObj = {};
                        isMap = true;
                        continue;
                    } else if(m = line.match(/^-\s*(.*)/)) {
                        if(currentObj != null)
                            currentObj.push(processValue(m[1]));
                        else {
                            if (isMap) {
                                isMap = false;
                                if (typeof(res.length) === "undefined") {
                                    res = [];
                                }
                            }
                            res.push(processValue(m[1]));
                        }
                        continue;
                    }
                }

                if(currentObj != null) {
                    if (isMap) {
                        isMap = false;
                        if (typeof(res.length) === "undefined") {
                            res = [];
                        }
                    }
                    res.push(currentObj);
                }
            }

            for(var j = processedBlocks.length - 1; j >= 0; --j) {
                blocks.splice.call(blocks, processedBlocks[j], 1);
            }

            return res;
        }

        function semanticAnalysis(blocks) {
            var res = processBlock(blocks.children);
            return res;
        }

        function preProcess(src) {
            var m;
            var lines = src.split("\n");

            var r = regex["comment"];

            for(var i in lines) {
                if(m = lines[i].match(r)) {
                    /*                var cmt = "";
                                    if(typeof m[3] != "undefined")
                                        lines[i] = m[1];
                                    else if(typeof m[3] != "undefined")
                                        lines[i] = m[3];
                                    else
                                        lines[i] = "";
                                        */
                    if(typeof m[3] !== "undefined") {
                        lines[i] = m[0].substring(0, m[0].length - m[3].length);
                    }
                }
            }

            return lines.join("\n");
        }

        function eval1(str) {
            errors = [];
            reference_blocks = [];
            var pre = preProcess(str)
            var doc = parser(pre);

            return semanticAnalysis(doc);
        }

        return {
            /**
             * Parse a YAML file from a string.
             * @param {String} str String with the YAML file contents.
             * @function
             */
            eval : eval1,

            /**
             * Get errors found when parsing the last file.
             * @function
             * @returns Errors found when parsing the last file.
             */
            getErrors : function() { return errors; },
        }
    })();

