export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: '서버에 Gemini API 키가 설정되지 않았습니다.' });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const systemInstruction = `
    당신은 평범하고 사소한 일상 문구를 허세와 웅장함, 비즈니스 전문 용어가 가득한 '링크드인식 화법'으로 바꾸어 주는 바이럴 마케팅 전문가입니다.
    입력된 문장의 핵심 의도나 맥락을 비틀어, 소름 돋을 정도로 진지한 커리어적 깨달음으로 확장시켜 장문의 한국어 포스팅을 작성해 주세요.

    [작성 조건]
    1. 도입부는 강력한 대제목으로 시작할 것 (형식 예: [Strategic Pivot] 이나 [Career Milestone] 같은 영문 대괄호 키워드 필수).
    2. 본문 작성 중 현실 탭에 작성된 글 전체를 그대로 사용하지 말 것. (예: 현실 = A는 B다, 결과물 = "A는 B다" 라는 생각을 했습니다.)
    3. 본문에는 '린(Lean) 오퍼레이션', '애자일(Agile)', '얼라인먼트(Alignment)', '리소스 최적화(Resource Optimization)', '고객 경험(CX)', '피벗(Pivot)', '임팩트(Impact)', '거버넌스(Governance)' 같은 용어를 문맥에 맞게 적극 활용할 것.
    4. 핵심적인 전문 비즈니스 개념 뒤에는 반드시 영문 괄호를 병기할 것 (예: 의사결정(Decision Making)).
    5. 글 중간에 가독성을 위해 글머리 기호(ㅇ 또는 -)를 사용하여 역량이나 액션 플랜을 2~3가지로 구조화하여 보여줄 것.
    6. 문체는 "~했습니다", "~를 통감합니다" 처럼 극도로 진지하고 성찰적인 어조를 유지할 것.
    7. 마지막에는 오글거리는 교훈적 멘트 또는 소통을 이어가려는 멘트와 함께 본문과 관련된 비즈니스 해시태그를 5개 이상 달아줄 것.
    `;

    try {
        // 1. Gemini AI에게 번역 요청
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `${systemInstruction}\n\n변환할 현실 문구: "${text}"` }]
                }]
            })
        });

        const data = await response.json();

        if (response.ok && data.candidates && data.candidates[0].content.parts[0].text) {
            let aiResult = data.candidates[0].content.parts[0].text;
            aiResult = aiResult.replace(/###/g, '').replace(/\*\*/g, '');

            // 2. [구글 시트 저장] 번역 성공 시 구글 시트에 데이터 전송
            try {
                await appendToGoogleSheet(text, aiResult);
            } catch (sheetError) {
                console.error('구글 시트 저장 실패:', sheetError);
            }

            return res.status(200).json({ result: aiResult });
        } else {
            return res.status(500).json({ error: 'Gemini API 호출에 실패했습니다.' });
        }
    } catch (error) {
        return res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
}

async function appendToGoogleSheet(inputText, outputText) {
    const sheetId = process.env.GOOGLE_SHEET_ID ? process.env.GOOGLE_SHEET_ID.trim() : undefined;
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL ? process.env.GOOGLE_CLIENT_EMAIL.trim() : undefined;
    
    let privateKey = process.env.GOOGLE_PRIVATE_KEY;
    if (privateKey) {
        privateKey = privateKey.trim();
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        privateKey = privateKey.replace(/\\n/g, '\n');
    }

    if (!sheetId || !clientEmail || !privateKey) {
        console.error('구글 시트 환경변수 설정 미흡');
        return;
    }
    
    const authUrl = 'https://oauth2.googleapis.com/token';
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    
    const now = Math.floor(Date.now() / 1000);
    const jwtClaim = Buffer.from(JSON.stringify({
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: authUrl,
        exp: now + 3600,
        iat: now
    })).toString('base64url');

    const crypto = await import('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${jwtHeader}.${jwtClaim}`);
    const signature = sign.sign(privateKey, 'base64url');
    const jwt = `${jwtHeader}.${jwtClaim}.${signature}`;

    const tokenResponse = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
        throw new Error('구글 엑세스 토큰 발급 실패');
    }

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:C1:append?valueInputOption=USER_ENTERED`;
    const kstDate = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);

    await fetch(appendUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            values: [[kstDate, inputText, outputText]]
        })
    });
}
