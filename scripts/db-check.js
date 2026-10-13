/**
 * 로컬에서 DynamoDB(sap_facts)가 제대로 붙는지 한 번에 확인한다.
 *
 *   node scripts/db-check.js            읽기만 — 아무것도 바꾸지 않는다
 *   node scripts/db-check.js --write    쓰기까지 — 시험용 행을 넣었다 지운다
 *
 * 실패하면 "무엇이 없어서 안 되는지"를 한국어로 말해준다. AWS 오류 메시지는
 * 자격증명 문제인지 권한 문제인지 테이블 문제인지 구분이 잘 안 되기 때문이다.
 */
const path = require('path');

const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const TABLE  = 'sap_facts';
const WRITE  = process.argv.includes('--write');

let DynamoDBClient, DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand,
    UpdateCommand, DeleteCommand, DescribeTableCommand;
try {
  const base = path.join(__dirname, '..', 'lambda', 'node_modules');
  ({ DynamoDBClient, DescribeTableCommand } = require(path.join(base, '@aws-sdk/client-dynamodb')));
  ({ DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand }
    = require(path.join(base, '@aws-sdk/lib-dynamodb')));
} catch (e) {
  console.error('✗ AWS SDK 가 없습니다. lambda 폴더에서 `npm install` 을 돌리세요.');
  console.error('  (' + e.message + ')');
  process.exit(1);
}

const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });

function ok(m)   { console.log('✓ ' + m); }
function bad(m)  { console.log('✗ ' + m); }
function hint(m) { console.log('  → ' + m); }

/** AWS 오류를 "그래서 뭘 해야 하는지" 로 바꿔준다. */
function explain(e, what) {
  const n = e.name || '';
  if (/CredentialsProviderError|NoCredentials|Unable to locate credentials/i.test(n + e.message)) {
    bad('AWS 자격증명이 없습니다.');
    hint('`aws configure` 를 실행하고 Access Key / Secret / ' + REGION + ' 을 넣으세요.');
    return;
  }
  if (n === 'ResourceNotFoundException') {
    bad(TABLE + ' 테이블이 ' + REGION + ' 에 없습니다.');
    hint('리전이 맞는지 먼저 보세요. 다른 리전에 만들면 여기선 안 보입니다.');
    return;
  }
  if (n === 'AccessDeniedException' || /not authorized/i.test(e.message)) {
    bad(what + ' 권한이 없습니다.');
    const act = (e.message.match(/dynamodb:\w+/) || [])[0];
    hint('IAM 에서 ' + (act ? act + ' 를 ' : '') + TABLE + ' 에 허용하세요.');
    hint('로컬 자격증명의 IAM 사용자와 Lambda 역할은 별개입니다 — 둘 다 필요할 수 있습니다.');
    return;
  }
  if (n === 'UnrecognizedClientException' || n === 'InvalidSignatureException') {
    bad('자격증명이 유효하지 않습니다(키가 틀렸거나 비활성).');
    hint('`aws configure` 로 다시 넣으세요.');
    return;
  }
  bad(what + ' 실패: ' + n + ' — ' + e.message);
}

async function main() {
  console.log('리전 ' + REGION + ' · 테이블 ' + TABLE + (WRITE ? ' · 쓰기 시험 포함' : ' · 읽기만') + '\n');

  // 1. 테이블이 있는가
  try {
    const d = await raw.send(new DescribeTableCommand({ TableName: TABLE }));
    const t = d.Table;
    const keys = (t.KeySchema || []).map(k => k.AttributeName + '(' + k.KeyType + ')').join(' · ');
    ok('테이블 있음 — ' + t.TableStatus + ' · ' + keys + ' · ' + (t.ItemCount || 0) + '건');

    const want = { subject: 'HASH', factId: 'RANGE' };
    for (const k of t.KeySchema || []) {
      if (want[k.AttributeName] !== k.KeyType) {
        bad('키가 다릅니다: ' + k.AttributeName + ' 가 ' + k.KeyType);
        hint('파티션 키 subject, 정렬 키 factId 여야 합니다. 대소문자도 같아야 합니다.');
      }
    }
  } catch (e) { explain(e, '테이블 조회'); process.exit(1); }

  // 2. Scan — 지식 목록 화면이 쓰는 권한. 여기서 막히면 화면이 빈 채로 뜬다.
  let items = [];
  try {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 300 }));
    items = r.Items || [];
    ok('Scan 됨 — ' + items.length + '건 읽음');
  } catch (e) { explain(e, 'Scan(전체 목록)'); }

  // 3. Query — 오브젝트별 조회
  try {
    const subject = items.length ? items[0].subject : 'ZZ_NOT_EXIST';
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'subject = :s',
      ExpressionAttributeValues: { ':s': subject },
    }));
    ok('Query 됨 — [' + subject + '] ' + (r.Items || []).length + '건');
  } catch (e) { explain(e, 'Query(오브젝트별 조회)'); }

  if (items.length) {
    const counts = {};
    items.forEach(f => { counts[f.status] = (counts[f.status] || 0) + 1; });
    console.log('\n쌓인 사실: ' + Object.keys(counts).map(k => k + ' ' + counts[k]).join(' · '));
    items.slice(0, 3).forEach(f => {
      console.log('  [' + f.subject + '] ' + String(f.body).slice(0, 70));
    });
  }

  if (!WRITE) {
    console.log('\n쓰기까지 보려면: node scripts/db-check.js --write');
    return;
  }

  // 4. 쓰기 왕복 — 넣고, 고치고, 동시수정이 막히는지 보고, 지운다
  const key = { subject: '_DBCHECK', factId: 'f' + Date.now().toString(36) };
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: Object.assign({}, key, {
        body: '점검용 행입니다. 남아 있으면 지워도 됩니다.',
        status: 'draft', rev: 1,
        createdAt: new Date().toISOString(), createdBy: 'db-check', updatedBy: 'db-check',
        updatedAt: new Date().toISOString(),
      }),
    }));
    ok('Put 됨 — ' + key.factId);

    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: key,
      UpdateExpression: 'SET body = :b, rev = rev + :one',
      ConditionExpression: 'rev = :rev',
      ExpressionAttributeValues: { ':b': '고친 내용', ':one': 1, ':rev': 1 },
    }));
    ok('Update 됨 (rev 1 → 2)');

    // 같은 rev 로 또 고치면 막혀야 한다. 안 막히면 동시수정 보호가 없는 것이다.
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: key,
        UpdateExpression: 'SET body = :b',
        ConditionExpression: 'rev = :rev',
        ExpressionAttributeValues: { ':b': '덮어쓰기 시도', ':rev': 1 },
      }));
      bad('동시 수정이 막히지 않았습니다 — 조건부 저장이 동작하지 않습니다.');
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') ok('동시 수정 차단됨 (의도대로)');
      else explain(e, '조건부 Update');
    }
  } catch (e) { explain(e, '쓰기'); }

  try {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));
    ok('점검용 행 정리됨');
  } catch (e) {
    bad('점검용 행을 못 지웠습니다 — ' + (e.name || e.message));
    hint('콘솔에서 subject=_DBCHECK 행을 지우세요. (DeleteItem 권한이 없을 수 있습니다)');
  }

  console.log('\n끝났습니다.');
}

main().catch((e) => { explain(e, '점검'); process.exit(1); });
