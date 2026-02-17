# API Collection - NEWZAP WhatsApp (Itsukichan Baileys)

Base URL:
- `http://localhost:{PORT}`

Auth obrigatoria em todas as rotas:
- Header: `Authorization: Bearer {AUTH_TOKEN}`

Content-Type para POST/DELETE com body:
- `application/json`

## 1) Rotas Existentes (Projeto Atual)

### GET
- `GET /`
- `GET /api/bailey/status`
- `GET /api/bailey/qr`
- `GET /api/docs/index?q=&level=`
- `GET /api/docs/section?title=&anchor=`
- `GET /api/docs/search?q=&limit=&level=`
- `GET /api/tasks?status=&to=`
- `GET /api/tasks/:id`

### POST
- `POST /api/bailey/start`
- `POST /api/bailey/restart`
- `POST /api/bailey/logout`
- `POST /api/bailey/shutdown`
- `POST /api/send`
- `POST /api/tasks/:id/cancel`

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

---

## 4) Formato de Destino (`to`)

Aceitos:
- Usuario: `5511999999999` ou `5511999999999@s.whatsapp.net`
- Grupo: `123456789-123456@g.us`
- Broadcast list: `123456789@broadcast`
- Status: `status@broadcast`

---

## 5) `/api/send` - Tipos de envio

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
- `media`: `{ "url": "..." }` (ou buffer/stream no backend)
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
- Se expirar, marca `expired` e executa `onTimeout.action` (se existir).
- Persistencia: `data/response_tasks.json`.

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
- filtros: `status=pending|completed|expired|cancelled`, `to=5511...`

Detalhe:
- `GET /api/tasks/:id`

Cancelar:
- `POST /api/tasks/:id/cancel`

Remover:
- `DELETE /api/tasks/:id`

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

## 9) Requests prontos (cURL)

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
