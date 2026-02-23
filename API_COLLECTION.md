# API Collection - NEWZAP WhatsApp (Itsukichan Baileys)

Base URL:
- `http://localhost:{PORT}`

Autenticacao:
- API (`/api/*`): obrigatorio `Authorization: Bearer {AUTH_TOKEN}`
- Frontend (`/` + `/ui/*`): login por senha local do painel (cookie de sessao)

Variaveis de ambiente recomendadas:
- `AUTH_TOKEN` (obrigatoria para `/api/*`)
- `UI_PASSWORD_HASH` (obrigatoria para login do painel `/`)
  formato: SHA-256 em hex (64 chars)
- `IA_REQUEST_TIMEOUT_MS` (opcional, default `12000`)
- `BOT_TYPING_ENABLED` (opcional, default `true`)
- `BOT_TYPING_MIN_MS` (opcional, default `280`)
- `BOT_TYPING_MAX_MS` (opcional, default `1300`)
- `BOT_TYPING_CHAR_FACTOR_MS` (opcional, default `14`)
- `TIMEOUT_ACTION_RETRY_ATTEMPTS` (opcional, default `3`)
- `TIMEOUT_ACTION_RETRY_DELAY_MS` (opcional, default `1200`)

Content-Type para POST/DELETE com body:
- `application/json`

## 1) Rotas Disponiveis

### GET
- `GET /` (frontend do painel)
- `GET /api/bailey/status`
- `GET /api/bailey/qr`
- `GET /api/bailey/qr/render?format=&width=&margin=`
- `GET /api/docs/index?q=&level=`
- `GET /api/docs/section?title=&anchor=`
- `GET /api/docs/search?q=&limit=&level=`
- `GET /api/tasks?status=&to=`
- `GET /api/tasks/stats`
- `GET /api/tasks/:id`

### GET (frontend autenticado por senha)
- `GET /ui/api/me`
- `GET /ui/api/status`
- `GET /ui/api/qr`
- `GET /ui/api/examples`
- `GET /ui/api/tasks?status=&to=&limit=`

### POST
- `POST /api/bailey/start`
- `POST /api/bailey/restart`
- `POST /api/bailey/logout`
- `POST /api/bailey/shutdown`
- `POST /api/send`
- `POST /api/tasks/:id/cancel`
- `POST /api/tasks/permanent`
- `POST /ui/login`
- `POST /ui/logout`
- `POST /ui/api/bailey/start`
- `POST /ui/api/bailey/restart`
- `POST /ui/api/bailey/logout`
- `POST /ui/api/bailey/shutdown`
- `POST /ui/api/send`
- `POST /ui/api/tasks/permanent`

### DELETE
- `DELETE /api/tasks/:id`

### PUT/PATCH
- Nao existem no projeto atual.

---

## 2) Fluxo Basico de Operacao

1. `POST /api/bailey/start`
2. Poll em `GET /api/bailey/qr` ate receber string de QR
3. Escanear QR no WhatsApp
4. Confirmar `GET /api/bailey/status` => `connected`
5. Enviar mensagens em `POST /api/send`

---

## 3) Erros Comuns

- `401 UNAUTHORIZED`: token invalido ou ausente
- `409 BOT_NOT_STARTED`: bot ainda nao iniciado
- `428 QR_REQUIRED`: esperando scan do QR
- `401 LOGGED_OUT`: sessao caiu e precisa reconectar
- `503 BOT_OFFLINE`: socket indisponivel
- `SVG_TO_PNG_DEPENDENCY_MISSING_SHARP`: dependencia `sharp` nao instalada para rasterizar SVG em PNG

---

## 4) Formato de Destino (`to`)

Aceitos:
- Usuario: `5511999999999` ou `5511999999999@s.whatsapp.net`
- Grupo: `123456789-123456@g.us`
- Broadcast list: `123456789@broadcast`
- Status: `status@broadcast`

---

## 5) `/api/send` - Tipos de envio

Regra mais importante:
- `POST /api/send` recebe **1 payload por vez**.
- Nao envie um objeto agregador com varias chaves (`sendText`, `sendMenuWithTimeout`, etc) no mesmo body.

Mapeamento real do backend (`sendAny.js`):
- `type = "text"` -> `sendText.js` -> exige `to` e `text`.
- `type = "interactive"` -> `sendInteractive.js` -> exige `to` e `content` objeto.
- `type = "media"` -> `sendMedia.js` -> exige `to`, `mediaType`, `media`.
- `type = "ia"` -> `sendIA.js`.
- `type` vazio:
  - se tem `mediaType + media` -> `sendMedia`.
  - se tem apenas `text` -> `sendText`.
  - se tem `content` objeto ou outras chaves de conteudo -> `sendInteractive`.

Regras de `awaitResponse`:
- `awaitResponse` e tratado pelo service de tasks, nao por `sendAny`.
- Ele funciona junto com `type: "text"` e `type: "interactive"`.
- Ao enviar `action.mode = "send"` com `payload.awaitResponse`, cria nova task automaticamente.

Efeito "digitando":
- Antes de cada envio `text`, `media` e `interactive`, a API envia presenca `composing` por alguns ms e depois `paused`.
- O tempo e calculado por tamanho do texto (com limites min/max) e pode ser desligado por env.
- E best-effort: se o update de presenca falhar, o envio da mensagem continua normalmente.

## 5.1 Texto

Request:
```json
{
  "type": "text",
  "to": "5511999999999",
  "text": "Ola, tudo bem?"
}
```

Com mencao:
```json
{
  "type": "text",
  "to": "5511999999999",
  "text": "Oi @{5511988887777}"
}
```

## 5.2 Midia

Campos:
- `mediaType`: `image | video | audio | document | sticker`
- `media`: aceita:
  - `{ "url": "..." }`
  - `{ "svgUrl": "https://site.com/arte.svg" }` ou `{ "svg_url": "https://site.com/arte.svg" }`
  - `{ "dataUrl": "data:image/png;base64,..." }`
  - `{ "svg": "<svg ...>...</svg>" }` ou `{ "html": "<html>...<svg ...></svg>...</html>" }`
  - string direta: `"data:image/png;base64,..."` ou `"<svg ...>...</svg>"`
  - buffer/stream no backend
- opcionais: `caption`, `mimetype`, `gifPlayback`, `ptv`, `viewOnce`

Imagem:
```json
{
  "type": "media",
  "to": "5511999999999",
  "mediaType": "image",
  "media": { "url": "https://site.com/img.jpg" },
  "caption": "Legenda"
}
```

Imagem por data URL (PNG):
```json
{
  "type": "media",
  "to": "5511999999999",
  "mediaType": "image",
  "media": {
    "dataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  },
  "caption": "Imagem enviada em base64"
}
```

SVG inline:
```json
{
  "type": "media",
  "to": "5511999999999",
  "mediaType": "image",
  "media": {
    "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"512\" height=\"512\"><rect width=\"100%\" height=\"100%\" fill=\"#fff\"/><text x=\"20\" y=\"40\">Hello</text></svg>"
  },
  "caption": "SVG inline"
}
```

Observacao de compatibilidade SVG:
- Quando `mediaType = image` e a origem e SVG (`svg`, `html`, `data:image/svg+xml` ou URL `.svg`), a API rasteriza para `PNG` e envia como `image/png`.
- O objetivo e garantir exibicao visual como imagem, evitando envio como documento SVG.

Video com gifPlayback:
```json
{
  "type": "media",
  "to": "5511999999999",
  "mediaType": "video",
  "media": { "url": "https://site.com/video.mp4" },
  "gifPlayback": true
}
```

## 5.3 Interativo Generico

Use `type: "interactive"` e passe o payload Itsukichan/Baileys em `content`.

Exemplo - Buttons Message:
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "text": "Escolha uma opcao",
    "footer": "Atendimento",
    "buttons": [
      { "buttonId": "a01", "buttonText": { "displayText": "Falar com vendedor" } },
      { "buttonId": "a02", "buttonText": { "displayText": "Encerrar atendimento" } }
    ]
  }
}
```

Exemplo - Buttons + image:
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "image": { "url": "https://site.com/banner.jpg" },
    "caption": "Selecione uma acao",
    "buttons": [
      { "buttonId": "sim", "buttonText": { "displayText": "Sim" } },
      { "buttonId": "nao", "buttonText": { "displayText": "Nao" } }
    ]
  }
}
```

Observacao importante:
- Quando enviar `image + caption + footer` sem `buttons/interactiveButtons/sections`, alguns clientes WhatsApp nao exibem o `footer` separado.
- Nesta API, nesses casos, o `footer` e concatenado no final do `caption` automaticamente para garantir exibicao.
- Em `content.image`, tambem sao aceitos `url`, `dataUrl`, `svg` e `html` contendo `<svg>`.
- Se `content.image` vier em SVG (inline/data URL/url `.svg`), a API converte para `PNG` e envia como imagem nativa.

Exemplo - Interactive com SVG inline (renderizado como PNG):
```json
{
  "type": "interactive",
  "to": "120363421971166966@g.us",
  "content": {
    "image": {
      "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1080\" height=\"1080\" viewBox=\"0 0 1080 1080\"><rect width=\"1080\" height=\"1080\" fill=\"#0a1220\"/></svg>"
    },
    "caption": "Imagem SVG renderizada como PNG no envio",
    "footer": "Gerenciamento de escala"
  }
}
```

Exemplo - List Message:
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "text": "Menu principal",
    "title": "Opcoes",
    "buttonText": "Abrir lista",
    "sections": [
      {
        "title": "Atendimento",
        "rows": [
          { "title": "Financeiro", "rowId": "fin" },
          { "title": "Suporte", "rowId": "sup" }
        ]
      }
    ]
  }
}
```

Exemplo - Buttons Interactive (PIX/PAY):
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "text": "Pagamento",
    "footer": "Loja XYZ",
    "interactiveButtons": [
      {
        "name": "pix_payment",
        "buttonParamsJson": "{\"currency\":\"BRL\",\"total_amount\":{\"value\":1090,\"offset\":100},\"reference_id\":\"PED123\",\"key_type\":\"CPF\",\"key\":\"12345678909\",\"merchant_name\":\"Loja XYZ\"}"
      },
      {
        "name": "payment_info",
        "buttonParamsJson": "{\"reference_id\":\"PED123\",\"payment_type\":\"pix\"}"
      }
    ]
  }
}
```

Exemplo - Localizacao:
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "location": {
      "degreesLatitude": -23.55052,
      "degreesLongitude": -46.633308
    }
  }
}
```

Exemplo - Poll:
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "poll": {
      "name": "Voce confirma?",
      "values": ["Sim", "Nao"],
      "selectableCount": 1
    }
  }
}
```

Exemplo - Contato:
```json
{
  "type": "interactive",
  "to": "5511999999999",
  "content": {
    "contacts": {
      "displayName": "Suporte",
      "contacts": [
        {
          "vcard": "BEGIN:VCARD\nVERSION:3.0\nFN:Suporte\nTEL;type=CELL;type=VOICE;waid=5511999999999:+55 11 99999-9999\nEND:VCARD"
        }
      ]
    }
  }
}
```

Exemplo - Status mentions:
```json
{
  "type": "interactive",
  "to": "status@broadcast",
  "content": {
    "text": "Atualizacao do dia",
    "jids": [
      "5511999999999@s.whatsapp.net",
      "5511888888888@s.whatsapp.net"
    ]
  }
}
```

## 5.4 IA

```json
{
  "type": "ia",
  "to": "5511999999999",
  "message": "Crie um menu com 3 opcoes",
  "context": "Atendimento da empresa"
}
```

---

## 6) `awaitResponse` completo (todos os campos)

Use dentro do mesmo body do `POST /api/send`.

Exemplo de estrutura:
```json
{
  "type": "interactive",
  "to": "558296921589",
  "content": {
    "text": "Deseja continuar?",
    "buttons": [
      { "buttonId": "sim", "buttonText": { "displayText": "Sim" } },
      { "buttonId": "nao", "buttonText": { "displayText": "Nao" } }
    ]
  },
  "awaitResponse": {
    "timeoutMs": 45000,
    "expected": [
      {
        "key": "sim",
        "aliases": ["Sim"],
        "action": {
          "mode": "send",
          "payload": {
            "type": "text",
            "text": "Perfeito, vamos continuar."
          }
        }
      },
      {
        "key": "nao",
        "aliases": ["Nao"],
        "action": {
          "mode": "webhook",
          "method": "POST",
          "url": "https://seuservidor.com/rota-nao",
          "headers": {
            "x-api-key": "abc"
          },
          "body": {
            "evento": "resposta_nao"
          }
        }
      }
    ],
    "onTimeout": {
      "action": {
        "mode": "send",
        "payload": {
          "type": "text",
          "text": "Tempo esgotado. Se quiser, chame novamente."
        }
      }
    }
  }
}
```

Campos de `awaitResponse`:
- `timeoutMs`:
  tempo maximo para esperar resposta (ms).
  default: `20000`.
  se `0`, `null` ou valor negativo: sem expiracao automatica (task fica ativa ate resposta/cancelamento).
- `persistent`:
  se `true`, cria a task como comando permanente (`status = persistent`) e ignora expiracao.
- `expected`:
  array de respostas aceitas.
  se nao informar, a API tenta inferir automaticamente dos `buttons/sections/interactiveButtons` enviados.

Campos de cada item em `expected[]`:
- `key`:
  id esperado (ex.: `buttonId`, `rowId`, `id` do native flow).
- `aliases`:
  textos alternativos aceitos para casar resposta (ex.: `["Sim", "S"]`).
- `action`:
  acao executada quando esse item for escolhido.

Campos de `action`:
- `mode`:
  `send` | `webhook` | `none`.
  se `url` existir, webhook tambem funciona sem `mode`.
- `payload`:
  usado quando `mode = "send"`.
  e o mesmo body aceito pelo `/api/send` (sem precisar de `to`, pois usa o mesmo destinatario por padrao).
  se `payload.awaitResponse` for enviado, a API cria automaticamente uma nova task (encadeamento/recursao).
- `to`:
  opcional em `mode = "send"` para sobrescrever destinatario.
- `url`:
  usado para webhook.
- `method`:
  webhook method (default `POST`).
- `headers`:
  headers do webhook.
- `body`:
  body custom do webhook.
- `timeoutMs`:
  timeout do webhook individual (default interno: `8000` ms).

Campos de `onTimeout`:
- `onTimeout.action`:
  mesma estrutura de `action` acima.
  executa quando a tarefa expira.

Onde colocar cada campo:
- Tudo que e envio WhatsApp vai no body principal de `/api/send` (`type`, `to`, `content`, etc).
- Controle de espera/resposta vai dentro de `awaitResponse`.
- Acao por opcao fica em `awaitResponse.expected[i].action`.
- Acao de expiracao fica em `awaitResponse.onTimeout.action`.

Comportamento real:
- So processa resposta do mesmo `to` da tarefa.
- Se resposta nao casar com `expected`, ignora.
- Se casar, marca `completed` e executa acao.
- Para task `persistent`, nao finaliza: continua ativa e atualiza `triggerCount`/`lastTriggeredAt`.
- Quando um novo fluxo temporario e criado para o mesmo `to`, tasks anteriores `pending/attending` desse `to` sao canceladas automaticamente.
- Quando um comando `persistent` dispara, tasks temporarias abertas do mesmo `to` tambem sao canceladas automaticamente.
- Se expirar, marca `expired` e executa `onTimeout.action` (se existir).
- Timeout action tem retry automatico (default: 3 tentativas com 1200ms entre elas), configuravel por env.
- Persistencia local: `data/tasks.db` (SQLite) com sincronizacao em background com Supabase quando configurado.
- Sync Supabase: no boot, a API pode fazer pull de tarefas ativas (`pending`/`attending`/`persistent`) 1x se local estiver vazio/desatualizado; depois usa o banco local e faz upsert/delete em background em tabelas separadas por estado.

### Exemplo: botao com resposta fixa de texto (sem webhook)

```json
{
  "type": "interactive",
  "to": "558296921589",
  "content": {
    "text": "Deseja falar com vendedor?",
    "buttons": [
      { "buttonId": "a01", "buttonText": { "displayText": "Sim" } },
      { "buttonId": "a02", "buttonText": { "displayText": "Nao" } }
    ]
  },
  "awaitResponse": {
    "timeoutMs": 20000,
    "expected": [
      {
        "key": "a01",
        "aliases": ["Sim"],
        "action": {
          "mode": "send",
          "payload": {
            "type": "text",
            "text": "Otimo. Um vendedor vai te atender agora."
          }
        }
      },
      {
        "key": "a02",
        "aliases": ["Nao"],
        "action": {
          "mode": "send",
          "payload": {
            "type": "text",
            "text": "Sem problemas. Atendimento encerrado."
          }
        }
      }
    ],
    "onTimeout": {
      "action": {
        "mode": "send",
        "payload": {
          "type": "text",
          "text": "Tempo de resposta encerrado."
        }
      }
    }
  }
}
```

---

## 7) Rotas de Tarefas (Controle)

Listar:
- `GET /api/tasks`
- filtros: `status=pending|attending|persistent|completed|expired|cancelled`, `to=5511...`

Estatisticas:
- `GET /api/tasks/stats`

Detalhe:
- `GET /api/tasks/:id`

Cancelar:
- `POST /api/tasks/:id/cancel`

Remover:
- `DELETE /api/tasks/:id`

Criar comando permanente:
- `POST /api/tasks/permanent`

Body minimo:
```json
{
  "to": "558296921589",
  "trigger": "/menu",
  "action": {
    "mode": "send",
    "payload": {
      "type": "interactive",
      "to": "558296921589",
      "content": {
        "text": "Menu principal",
        "buttons": [
          { "buttonId": "a01", "buttonText": { "displayText": "Opcao 1" } }
        ]
      }
    }
  }
}
```

Notas:
- Esse endpoint cria uma task `persistent` sem timeout.
- Para multiplos gatilhos, envie `expected` no lugar de `trigger`.
- Para desativar, use `POST /api/tasks/:id/cancel` ou `DELETE /api/tasks/:id`.
- Se existir task temporaria aberta para o mesmo `to`, ela sera cancelada automaticamente quando o comando persistente disparar.

---

## 8) Onde pode / onde nao pode (Resumo pratico)

- Texto (`text`): privado, grupo, broadcast.
- Midia (`media`): privado, grupo, broadcast.
- Buttons Message (`buttons`): privado e grupo (depende do cliente).
- List Message (`sections + buttonText`): recomendado em privado. No `ITSUKICHAN.md` consta "Just working in a private chat".
- Status mentions (`to = status@broadcast`): stories/status.
- Conteudos de comercio/pagamento (PIX/PAY/product/shop/collection): dependem da conta/cliente suportar recurso.
- Mensagens para canal/newsletter: requer IDs e capacidade suportada da conta.

Se o WhatsApp do destino/conta nao suportar um tipo especifico, a API pode enviar erro do proprio protocolo.

---

## 9) Frontend Seguro (`/`)

Objetivo:
- A rota raiz `/` abre um painel web para operacao.
- Esse painel usa senha propria (nao usa `AUTH_TOKEN`).

Seguranca aplicada:
- Sessao por cookie `HttpOnly` + `SameSite=Strict`.
- Verificacao de sessao vinculada a IP + User-Agent.
- Rate limit de tentativas de login por IP com bloqueio temporario.
- Headers de seguranca (`CSP`, `X-Frame-Options`, `nosniff`, etc).
- `UI_PASSWORD_HASH` vem do `.env` (nao fica hardcoded no codigo).

Gerar hash SHA-256 da senha (PowerShell):
```powershell
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('SUA_SENHA_AQUI').digest('hex'))"
```

Rotas do frontend:
- `GET /` (pagina do painel)
- `POST /ui/login`
- `POST /ui/logout`
- `GET /ui/api/me`
- `GET /ui/api/status`
- `GET /ui/api/qr`
- `GET /ui/api/examples`
- `GET /ui/api/tasks`
- `GET /ui/api/tasks?status=&to=&limit=`
- `POST /ui/api/bailey/start|restart|logout|shutdown`
- `POST /ui/api/send` (proxy seguro para enviar payload com sessao do painel)
- `POST /ui/api/tasks/permanent` (criar comando permanente com sessao do painel)

Payload Builder do painel:
- Permite montar `text`, `interactive` com `awaitResponse` e comando `permanent`.
- Gera o JSON em tempo real para copia.
- Permite enviar direto com o botao `Enviar agora`, sem usar `AUTH_TOKEN` no navegador.

Formato de `GET /ui/api/examples`:
- Retorna `items[]` com `{ name, method, endpoint, body }`.
- Cada `item.body` deve ser enviado isoladamente no endpoint indicado.

## 10) Supabase Schema (4 tabelas)

Configuracao esperada no `.env`:
- `SUPABASE_TASKS_PERSISTENT_TABLE=response_tasks_persistent`
- `SUPABASE_TASKS_PENDING_TABLE=response_tasks_pending`
- `SUPABASE_TASKS_EXPIRED_TABLE=response_tasks_expired`
- `SUPABASE_TASKS_COMPLETED_TABLE=response_tasks_completed`

Observacao:
- `cancelled` e armazenado junto com expiradas em `response_tasks_expired`.

SQL de criacao (estrutura igual para as 4 tabelas):
```sql
create table if not exists public."response_tasks_persistent" (
  "id" text primary key,
  "status" text not null,
  "to" text,
  "scope" text,
  "requestBodyType" text,
  "sentMessageId" text,
  "expectedJson" text,
  "onTimeoutJson" text,
  "selectedJson" text,
  "responseJson" text,
  "actionResultJson" text,
  "createdAt" timestamptz,
  "createdAtMs" bigint,
  "expiresAt" timestamptz,
  "expiresAtMs" bigint,
  "timeoutMs" bigint,
  "updatedAt" timestamptz,
  "attendingAt" timestamptz,
  "completedAt" timestamptz,
  "expiredAt" timestamptz,
  "cancelledAt" timestamptz,
  "notes" text,
  "triggerCount" bigint default 0,
  "lastTriggeredAt" timestamptz
);

create table if not exists public."response_tasks_pending" (like public."response_tasks_persistent" including all);
create table if not exists public."response_tasks_expired" (like public."response_tasks_persistent" including all);
create table if not exists public."response_tasks_completed" (like public."response_tasks_persistent" including all);

create index if not exists idx_response_tasks_persistent_status on public."response_tasks_persistent" ("status");
create index if not exists idx_response_tasks_pending_status on public."response_tasks_pending" ("status");
create index if not exists idx_response_tasks_expired_status on public."response_tasks_expired" ("status");
create index if not exists idx_response_tasks_completed_status on public."response_tasks_completed" ("status");
```

## 11) Requests prontos (cURL)

Start:
```bash
curl -X POST "http://localhost:3000/api/bailey/start" ^
  -H "Authorization: Bearer SEU_TOKEN"
```

Status:
```bash
curl "http://localhost:3000/api/bailey/status" ^
  -H "Authorization: Bearer SEU_TOKEN"
```

QR atual:
```bash
curl "http://localhost:3000/api/bailey/qr" ^
  -H "Authorization: Bearer SEU_TOKEN"
```

Enviar texto:
```bash
curl -X POST "http://localhost:3000/api/send" ^
  -H "Authorization: Bearer SEU_TOKEN" ^
  -H "Content-Type: application/json" ^
  -d "{\"type\":\"text\",\"to\":\"5511999999999\",\"text\":\"Ola\"}"
```

Pesquisar docs:
```bash
curl "http://localhost:3000/api/docs/search?q=buttons%20reply%20message&limit=5" ^
  -H "Authorization: Bearer SEU_TOKEN"
```
