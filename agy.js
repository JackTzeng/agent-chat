'use strict';
// Google Antigravity CLI（agy）：命令列參數、權限對應、stream-json 事件解析。
// 事件格式（官方 headless 文件）：每行一個 JSON，第一層的 event 是 init／step_update／result。
//   init        { event, conversation_id, init: { model, permission_mode, cwd, tools } }
//   step_update { event, step_update: { conversation_id, step_index, state(ACTIVE|DONE|ERROR), step_type(user_input|agent_response|tool|checkpoint),
//                 tool_name, text_delta, usage, tool_info: { name, parameters, output, error: { type, message } } } }
//   result      { event, result: { conversation_id, status, response, error, duration_seconds, num_turns, usage, denied_actions } }

const READ_ONLY_DEFAULT = ['--mode', 'plan', '--sandbox'];

// 成員的存取等級：read＝只讀、給意見（預設）；write＝agy 預設模式：可以寫檔，也會真的執行指令（Windows 實測 run_command 結束碼 0）
const access = (agent) => (agent.agyAccess === 'write' ? 'write' : 'read');
// 唯讀要用的參數；可以用環境變數 AGY_READONLY_ARGS 換掉（例如 CLI 改版後參數名稱變了）
function readOnlyArgs() {
  const v = String(process.env.AGY_READONLY_ARGS || '').trim();
  const args = v ? v.split(/\s+/) : READ_ONLY_DEFAULT;
  if (args.some((a) => /dangerously|skip-permissions|always-proceed/i.test(a))) throw new Error('AGY_READONLY_ARGS 不能包含會略過權限的參數');
  return args;
}

const str = (v) => (typeof v === 'string' ? v : '');
// 工具參數的名稱各版本不一定相同：依序找幾個常見的
const pick = (params, keys) => { const p = params && typeof params === 'object' ? params : {}; for (const k of keys) if (str(p[k])) return p[k]; return ''; };
const FILE_KEYS = ['TargetFile', 'target_file', 'AbsolutePath', 'absolute_path', 'path', 'file_path', 'file', 'Path'];

function describeTool(name, params, short) {
  const n = String(name || 'tool');
  const file = () => short(pick(params, FILE_KEYS));
  if (/run_command|shell|terminal|bash/i.test(n)) return '⚙️ 執行：' + short(pick(params, ['CommandLine', 'command_line', 'command', 'Command', 'cmd']));
  if (/write_to_file|create_file|write_file/i.test(n)) return '📝 建立：' + file();
  if (/replace_file|edit_file|multi_replace|apply_patch|edit/i.test(n)) return '📝 修改：' + file();
  if (/view_file|read_file|read_url|view_code|list_dir|view_file_outline/i.test(n)) return '📖 讀取：' + (file() || short(pick(params, ['DirectoryPath', 'directory_path', 'Url', 'url'])));
  if (/search_web|web_search/i.test(n)) return '🌐 搜尋網路：' + short(pick(params, ['query', 'Query']));
  if (/grep|find_by_name|code_search|search/i.test(n)) return '🔎 搜尋：' + short(pick(params, ['Query', 'query', 'Pattern', 'pattern']));
  if (/subagent/i.test(n)) return '🤖 派出子代理';
  return '🔧 ' + n;
}

// 文字是一小段一小段（text_delta）送來的：最後一筆可能是「最後一小段」也可能是「整段」，兩種都能處理
const mergeDelta = (buf, delta) => (!buf ? delta : delta.startsWith(buf) ? delta : buf + delta);

// 每一輪一個解析器（要記住還沒送出的文字與工具）
function makeParser(short) {
  const texts = new Map(), tools = new Map();
  let sawText = false, model = '';
  const flush = (idx, emit) => {
    const t = (texts.get(idx) || '').trim(); texts.delete(idx);
    if (t) { sawText = true; emit({ kind: 'text', text: t }); }
  };
  return function parse(ev, emit) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.event === 'init') {
      const i = ev.init || {};
      if (ev.conversation_id) emit({ kind: 'session', id: String(ev.conversation_id) });
      model = i.model || '';
      // 不應該發生：agent 說自己是「全部自動核准」模式
      if (i.permission_mode === 'always-proceed') emit({ kind: 'tool', text: '⚠️ agy 回報權限模式是 always-proceed（全部自動核准），這不是預期的設定' });
      return;
    }
    if (ev.event === 'step_update') {
      const s = ev.step_update || {}, idx = s.step_index, st = s.state, type = s.step_type;
      if (type === 'agent_response') {
        if (typeof s.text_delta === 'string' && s.text_delta) texts.set(idx, mergeDelta(texts.get(idx) || '', s.text_delta));
        if (st === 'DONE' || st === 'ERROR') flush(idx, emit);
      } else if (type === 'tool') {
        const ti = s.tool_info || {}, name = ti.name || s.tool_name || 'tool', id = 'agy-' + idx;
        let t = tools.get(idx);
        if (!t) {
          t = { finished: false }; tools.set(idx, t);
          emit({ kind: 'tool', text: describeTool(name, ti.parameters, short), call: { id, name, input: ti.parameters || {} } });
        }
        if (!t.finished && (st === 'DONE' || st === 'ERROR' || ti.error)) {
          t.finished = true;
          const err = ti.error;
          const out = ti.output == null ? '' : typeof ti.output === 'string' ? ti.output : JSON.stringify(ti.output);
          emit({ kind: 'toolres', id, isError: !!err || st === 'ERROR', text: err ? str(err.message) || str(err.type) || '工具執行失敗' : out });
        }
      }
      return;
    }
    if (ev.event === 'result') {
      const r = ev.result || {};
      for (const idx of [...texts.keys()]) flush(idx, emit);
      // 步驟事件沒帶文字時，退而求其次用最後的 response
      if (!sawText && str(r.response).trim()) { sawText = true; emit({ kind: 'text', text: r.response.trim() }); }
      if (r.conversation_id) emit({ kind: 'session', id: String(r.conversation_id) });
      for (const d of Array.isArray(r.denied_actions) ? r.denied_actions : [])
        emit({ kind: 'tool', text: '⛔ 被擋下：' + short(str(d.display_name) || str(d.action) || '某個動作') + '（這位成員沒有這個權限）' });
      const status = String(r.status || '');
      if (status === 'ERROR' || status === 'INVALID') emit({ kind: 'error', text: str(r.error) || 'agy 執行失敗（' + status + '）' });
      else if (status === 'WAITING') emit({ kind: 'error', text: 'agy 停在等待核准：有動作需要權限，但無人值守沒辦法核准（已被擋下）。要讓它做這件事，請到成員設定調整存取等級。' });
      else if (status === 'CANCELED' || status === 'INTERRUPTED') emit({ kind: 'error', text: 'agy 回報這一輪被中斷（' + status + '）' });
      else if (status && status !== 'SUCCESS') emit({ kind: 'error', text: 'agy 沒有完成（' + status + '）' });
      const u = r.usage || {};
      const inTok = (u.input_tokens || 0) + (u.cache_read_tokens || 0), outTok = (u.output_tokens || 0) + (u.thinking_tokens || 0);
      if (u.total_tokens) emit({ kind: 'ctx', tokens: u.total_tokens });
      const secs = typeof r.duration_seconds === 'number' ? r.duration_seconds.toFixed(1) + 's' : '';
      emit({ kind: 'done', meta: [model, u.total_tokens ? u.total_tokens + ' tokens' : '', secs].filter(Boolean).join(' · '),
        stats: { inTok, outTok, steps: r.num_turns || 0, costUsd: 0 } });
    }
  };
}

// 送進 stdin 的提示：一行 JSON 的 user 事件
const stdinMessage = (prompt) => JSON.stringify({ event: 'user', message: { content: String(prompt) } }) + '\n';

// 唯讀成員的提示詞：不能只靠 CLI 擋，也要明講
const READ_ONLY_NOTE = '【唯讀】你的角色是閱讀與評論：只能讀取檔案、用文字回覆意見；不要建立、修改、刪除或移動任何檔案，也不要執行任何指令。需要改動的地方，請在回覆中具體寫出建議，由其他成員動手。';
const WRITE_NOTE = '【權限】你可以建立與修改檔案，也可以執行指令。只在工作資料夾內動作，不要讀寫工作資料夾以外的地方；不要執行刪除大量檔案、改系統設定、安裝軟體、推送到遠端等有風險或不可回復的指令，需要時請在回覆中說明，由使用者決定。';

module.exports = { access, readOnlyArgs, makeParser, describeTool, stdinMessage, mergeDelta, READ_ONLY_NOTE, WRITE_NOTE, READ_ONLY_DEFAULT };
