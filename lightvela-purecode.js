#!/usr/bin/env node
/**
 * LightVela 纯代码复刻客户端（路线①）
 * ------------------------------------------------------------------
 * 不碰浏览器，直接按抓包还原的三层协议打：
 *   ① 官网 REST 拿 Bearer + 实例/bot + tat/session
 *   ② 腾讯云 TAT 中继 WS（wss）建隧道，PtyProxy 把 127.0.0.1:9119(Hermes) 映射出来
 *   ③ 在隧道里手写 Hermes WebSocket 客户端，发 prompt.submit 聊天
 *
 * 零依赖：只用 Node 内置 tls / https / crypto。
 *
 * 配置（环境变量，全部可选，有合理默认/联调时填）：
 *   LIGHTVELA_BEARER      官网 Bearer token（没有就靠 LIGHTVELA_COOKIE 去 /auth/session 换）
 *   LIGHTVELA_COOKIE      lightvela.ai 的会话 cookie（可选）
 *   LIGHTVELA_INSTANCE_ID 实例 id（不填则从 /v1/instances 取第一个）
 *   LIGHTVELA_BOT_ID      bot id（不填则从 /v1/instances/{id}/bots 取第一个）
 *   LIGHTVELA_REGION      TAT 中继区域，默认 ap-johorbahru
 *   LIGHTVELA_PROXY_HOST  隧道目标，默认 127.0.0.1
 *   LIGHTVELA_PROXY_PORT  隧道目标端口，默认 9119
 *   LIGHTVELA_HERMES_TOKEN Hermes token（联调兜底；正常由 PtyStart 输出 __LV_DASHBOARD_READY__ 解析）
 *   LIGHTVELA_SESSION_ID  TAT SessionId（不填由 tat/session 下发）
 *
 * 用法：
 *   node lightvela-purecode.js --message "你好，介绍一下你自己"
 *   node lightvela-purecode.js --repl        # 进入交互聊天
 */

'use strict';
const tls = require('tls');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { normalizeProxy, connectTunnel, makeHttpsAgent } = require('./lv-proxy');

// ===================== 设主模型脚本(hermes 官方模型配置, gzip+base64, 通用) =====================
// 前端【设定主模型】实际 = 向实例 POST /v1/instances/<id>/debug/exec，命令里解压执行此脚本，
// 并传 payload(JSON base64) 决定动作。脚本为官方通用版，纯代码只换 payload(sys.argv[1])。
const HERMES_MODEL_CFG_SCRIPT_B64 = "H4sIAAAAAAAACu19a3Mcx5Hgd/yKVuuDZqjBCKQo2kZ4FAGBkIgzCTAASGcdDtfRmCkAbTa657p7QEJcbFCSaUlhUtSe9Vi9vOKGvdad1qTP4ZAoiZT+yxoDgJ/0Fy6ynlmPnukBSOl8Z0bYwnS9srKysrLyVdFmN80KbzXMyamTYxH71U672+LvtXZSxOJHlORd0i7kz1T89Ys8TcTfaS7+yoj4KyftjBSyIM9ll/m2/FpEm7JBL4vjaLVJsizNjG8Z+e89khdjY2tZuum1s+1uka5nYXdju7kRvrQZFs1uFm1GRbRFco833QjzDZI3vJxkURhHL4VFlCZVOmiG+fbmJimyqC366oadTpSsN7wsD1kXGyTbJHnQjiNPYjBZi9a9MJdl9ENZ9c20Q+IcVWcfxsaKbHtyzPM8z2jYZLgIctLuZVGxLTpKuyQJ2hnpkKSIwph0gl4Wj5FLbdItvFlaZwZQyjp11vZa3lyakPKx5RxlwyCO1kh7ux0TmILreykIzk6qQrAWxvFq2L4QKHQbn0rHNZtWHTLsFRtoneCnGGOG/idKE9YBqlHSe7hOkqIJUJCkE0QUD2opn2HfZ8XnMPfO0C6Ngqr95eEmCTqkG6fbmyQp0CSMklKcOYcXc0NTNkcSs4/TsKPwrW2MJioby8MtUlYPlY2NLS5NLSx5Lc8PgrOzz51ZemHm7FRwZmbh3MxicG7+9MzZYHp+7tnZ54L/tDg/F9DaQeCPzcydrtxoZu40NJmempufm52eOkurLHot7zKdsd/eCIugnW52YwJLn/uTjm8Nz4etFkaDSwMoclfhg6UdcinISN5Nk5ywsYxPDf6ppGxwWzZKmBQbWdqN2sEmyfNwnVV2fG2gr2VVWJerpJOlbLNtkSwnUNv61pDf3MVjO2NLC1Nzi+fnF5aGrADGZ6Ma3kafe7VJje2Mzcy9MHN2/vxMsLR0NlicmZ6fOw3wn5qYGDs39XNOdLOng7Mzc88tnfFa3lPHT4xNLU7PzgIpLi3Mnw2mz0wtTE0vzSwEZ2fPzQLNP3lijDU8Pbs4Pf/CzMKLwdLsuZn555fQEE/iEVTFhZnF8/NzizPBMy8uUWI+4R3zjk+cOMn/MzbWjsM896bpPutl9LRcSBnHpAyhttBL4LimP+qMPXTDPBctz2fpVtQh2XyXsNZDWnXImhen60GXtws6Ud5Ot0i2HayFUdzLSI2gRo96/Rv/a/fbj/ffeX/vo3/3NkjcJZm3/8Ev+5/8au+T1w9uXuvf+OK7ux/2777Sv3On/+a/7L372l+vvLz31Vv7n7x8cPPaX6+8fPDF7f43v9y982b/f1+5/+qn/Rv/fP+1G/0btw9evdd/67P+a3/cu37rr1de4XwN+g/iKCG51/KWVzjPDTfhrKKANYOgyMI2oWdKQMsvbkQx4bWi3EvSgvJBL0w6XkySGu617v3UOzHBJgf/ojXWsFmsBuyPtQBIttlOg7UoJgkduuX5P82LTpQ87aumJsDNsNslSacm+4OvSVqXDcQ8ZIWEXCpoqTyu4F++nTfzokOyrHkxiwpS8xX7FAQ29dzc/OLS7LTne49TmbDZ6W1289plDTrYnowqYMt0s3SVBMDXO3L5xaaFcp0SSAfK2PzOwvT8SW22DTnSTt173PP/a+KzmboPaZ0CSbJF4rRLgk6UkXaRZts1TnBZmsI5luZNkmxFWZo010lR8/mxcWb+3Ixf99KsrMLC/PySrNANi40mudQNk04vJ1nN/8cnmuyQ46DK0dmItP4v0iipARQNz2/G0fpGsUXicFyJT+MCeNFLmjc3wwukE2V5TfbYoKJmayL90cREwyOXorwI0gutpaxHZKv2xmbawU1obVackaKXJQpChrduRrphRpAoGQhoBALxnFxoppWS9KLXoteAJvwf/7qWZh6l9ygB8OIISD5TANbxUlJhS0Mamgj0ouheo26+6aBGkySd/GJUbNT8Zpds+nW6YwG2cdnzOik2KYjwq+497bl4/CRUz8hmusXrydE4Mc4vIulKI0cKX3qBJF5L3J2a9HewQS7VTpxkXXWzaCssSDBk2qyjxz0+HXtri34uEFieLA+b6ySBLUoCVFTr9lbjqB2QS900IUnROvXUU0/+qOFdINtBHr1EWicmTv64bnW6ul1Qrol6amplNW36JGmncL1qaVe15gz/3Dw/c66hNVhLs82wMKqfZwM8S8ua5382vfjjhjkM3PuiNAnCeD3NomJj0+hjLp2RlWp11VxNsUPydhZ1izRj2Aexo4YXpQFf54P/vDA/d/ZF7x/Yr+mFmakl8WPm59NnYYedEjsM/gHxQfFah/aohml4/sVVIMjc2wiTTkwm+X85S9bwipaCLRxbXm0dZEGtLn48vDWh/fMlWeyt/oK0C/btZ2R7NllLEYqbHQL8v+aHeTuKfDUVzoAu+5So/UlG3A3P74qe/Ek0350hvB+2Ad6laO1Kd6vaoRSgMMoJY4MdQskFscHaVhj3CGdQ9G+v5YV50InaBSuDg05Wn+GMUexRzgAKconXZocKm3rd2bTJC8cEQ0tBDdNc68XxZli0N2qZvxyOr02M/2Tl8skf7/icO9Qn2US8F2AYJqyh3iXL5jBFuRclW2EcdfzhnMjF7t1MicMrWkc5iDr6olSFM8q9XhJuhVEcrsbExfSiNXzSOHk7HriUx1eDh1zqRhnpIEpub/SSC7ljedtRd4Nk8LVsjXGNZt6No6LmN1HXHI98hDSj4ib7BfM4dXIELOrrrLiTzer8TGdN+qmmHTE6Y6B3/y7Z1A4bztcyEnaAXGDPXUyzTgtEaMTZ4jBKABFKLOf8h80eZAY28UkX+ycdr8V1n83VUyc506ENGh6dd1gQJB0pxq+aY37Kv+vcUxuvYRVxdWJzfmrmfG1zfa0lPpx77tnjNXU4MRVmc/HM1ImnTtXq9YZXWtbw4nCVxAxX+oj6PCT6xCVBTgzRqaKLlrfq+2xTy5aKVfeKtfEfO6hQtm/mRRZ1a8P2cJR7ZLNbbNtcX1VigmGUhHG8/SC4OeXf7V5epJsBSTrdNEoKWFGQY2tCk1YXij1622x566QIiyKraRoq2LHufvyGp4g3WvPaYUyZE78IAlrYNNlvNSxtkMc90IZlpJn3VoGL/7ep8f8CbPxxuBAFfsPLC9UGNr3v15u9LvRUr3PU+4GvyfHifjL9/OLS/LkAbm10nMc9P5g6Pxv8bOZFH0ClH0mcE7OFqCRu8GGHYqwqpkSDUVFTVwcqcNDLO9//JU07SxRLdN7XYIb1hhKj2FYZz6N1v8HUB3nLz0g3DtuknIUCU8vCi/SeC3zNVQf+0fKWrCp2nVUvWvN4eZgV/MIDsn1WeH59UnQD/1n+0eRKMx7QD+xzWh/OGrPPRxlS/ZZP60UJrTIJNpIiSnrE6vAC2W5IaYl1x864lt/wjtsAMDpYBgbMYVzxWuyr+MD/+5j/mNwKj+mKgWejmMylxbNpL+kYtzIp73EiZOMxkqf6aKm1IskWlv7URMo2hMv80fD8Qb2KvUL3ict6Qvep1MlX2E0IzGrbloIHUNFG5ualTN8ekrJ8rACs+cyggE8Yeo3J3NJbOdB0JRjTH7QWIy7C4A4fyjJUxD+H7KGsAOu76hLouNcxFKRJvD0I7w99WpzLUyPUUae4TopAGQ03wiipMcDLZmdYGBueb3eBici0SI5MPxwcPItlkhTZNj052F9RQs8FOVaW9uC2z5vCKFEeJXkRJm1So00aHlxW6ytC0wfK2rAbcQt1Df6kWxGkaDAfN+itKu0VTNU4ZO1ZLw2hBVYdD5UIdKFPx0Q5UC0JnBiqRaE0pcOl7S7h8uGoXQ/ew3LCa6RobwyY8MjETrthC1R++xWeBq0jospG0+gda5R62edokD2lmbe8siNO2SQqopcoM14lARWZhP5EbWxOFNxGB9fMgtcS4jCXsRDHb3j+8sLMabCtnV7x65qwxEHj/S1PPjkxsQJLIwZgAvE5ivd2miSkXURbIHy3N0j7gsfNFWjjdNhaB1En1zRDEnf8CgtbVH5DmgGOInOfckTQfWqwDdj5UUE2YePXULd6B6qg4YF6nfeyvIK2mYCco5V2yrFqCoaAIlEbVOfyBxf/2FBiocXVU9TScc/9YACFrAL3/gGKYk04jILMvBaruOzDl+ez2F9pZlzke4LvBKig6oXdCNbQXxlDwFPjmssabN5Ja3LgaE0CgUwIT2wd9zk+Zc3HPf4Z/pBdW8Pblm1zcK1HqP4Erm53aNrBB/an6nGiNO/sjPL5gjg5D6W/YiPKvanzsxQOv44PEm1JtV1JSxryUITbbZgVpBOEBditiiwMNkjYIVlOtRwNcCmDkxNUEkzvMTl0qXkHcIH0p6FpUowDR6Mm/243jtpUP/UEGDLhkv18TrLxKXCygRrKCEc7H2dnqL8zGhVxGJq9Lqiaapf9S+NhNxq/QPXYGpuS3YyDZwE3np6YOPHk+MSp8Ynj/g7nzHFOrO6X/alesZFmXOPmw/3If4aEGcmoqdZQrBhAaeiGTX+Zj9UNt+EGL30x4B9jUoKNL/tRx19poNLwUkBVv8Dpj+MC5W+xfNnP0pguA9y9mTGYLg+1F0fJur/D+7SxXU7jCFonkJ4fJd2eGqPBoE17RbdXIKBPcW0Dp/uW4ZfYXODkbLBOm3Gp2XfCImwhezkHtd6kKgOlW2uYC9vi/1UFm6TYSDst//z84hL3anErvzUBw+kJWNd1C5XuD+N5uEa8M0tL570iC5Oc+Ym6xBGP+XHceqN/9dPdu58cfPOb3bsf7N25ev/93x188enex7/f++qt+69d79/6oP/WP+3e+SN4d1CvjO/ufrh753r/xu3+h7+9f+VK//U/mSvQy0B7nQj3DY+6OlKeSBefyx/+pHdqYgejBPEQ7LExKVov+6gG3UTot60MshBa4wA2vGPHeJdU2yOoVcd3XoRFDyCOkqImxEhRFW7htNxveCcmJuq6VgTmwlqDW8kE7Fn++2lwCpqwlUauxWX8Xagx+RlBOmx1qa6wyGqsXzS+EOi0Ify8126THPYPaNN1nbQv3T7khhRfwJ63YtQeyGBoDXHyT1qigFERJnsOgAIU13RzkDpw6tQtamICbT/Nroh9lZuAHIo/WFiiK5LEabbs04JpehRJDyLY6Zga1VcqvZ2cON7wTk48WZ80+znHWCfj6lwcRSoVSmBgbAVhVPRPYn2EVss7OXGySteSHoxdPbDrEz+p0rVgqRTksCBeDG7YOtg5GQlIN9Eq6Cy6FX3bYooQ8dPEJankBUC8vt1i9BmAHO0LHzdOzUoQ0ehb3QGYfI0Ie5hoO4bJSj+H1Y57NoxztOXwdhN/4oMYb68gQhYrtK/kpU4VaksxOfxehA9wtdcc/j/mwSUwTY977Ww1vOD4ih5B1Kw7x31EjksX2WXOckxeNncaVTOS9+KCmhMNDQsG1b5Ln5rgLl2mhKu6ljdJ6w7KBrUsduJ+Zu4IVK3kSqfbKwbs0kUSU4bEtRZlrMS1L43vhzxnbMIfQvxDN4D34A4U6agy/AzBWHVqSej/a1qSoRyPqbvz9gbZDIO81wUZjnR0dSdWyZXpc0VXzN8lKNKAW0ZlgVB6KV0mrJq960uCMTImrsj+zJk9xoMGqPJEDVp/DEiWxzJBYZ72MlCDGN0Ncxzlo1D2ypAHrK3GbzItxQSUE7UnXV8lG/TgGMJX1m4GxEOjFeroA3an9dMLkq9zzgtEywYG6bJ2GYkYk3SIHbpmcCBTZcTlnfpOHfc/M3ea380NB6W1iMQdtex0x7uVTw5OSBuDOsHb7OWFtwruz15Kfb90hTvth42vHGL44A0qGYD/DPPF4D65gmVaaj6skIrWZGPux1nwlgOhjXLZTIeTteWI4lzahakE/Nzi6CXqI2KEj1CCtGZZb8bpRWqtx6hW/QyDt5fIvaqDrLpgYCfkItB4p9emvgmaKtJ2MwjHX5JuBuPgL4bg1uQYBb8wsY7rcNC+uTeBZiFWqhShKsOfuFMCh13OhZ1jGga57OU3PDS9Ft0mg33wGP5pDeagZPpkafPk9ZnzGi4wpTWzF3F8aD3IjwxVYJAJUB+oOS17RlQHTOqfgKuxCWrqRiVe6gJi1AH3SQNEEEowdPS3LToyP0uTkMBaBmChbwwUMATYncyFm8QBglbsRDYvqSiYajjiw+loxmNotRHjYVSEuhWS1qTBBtgkRKkGv/qourlAtmeSLQcaeIHWAf9WApZUhmGaYRXzRVL0ukA0OT1i5c1YLwcpQp7AWAVvyAZ0tlKEYkQruHIIPvz0i8REwDS/wJ5Fo+FlUn3E3UcsbTgGUi5BFl5sqLWpY8sBCBHM4FkTIooGOPyNWAP93eDkI91cOQIQl0BTlfJlXbRroogWY83MW5/ZGWNldO7oa4eshb24QCMIlufqnp8hGtgQTSGE/CDqSMlL2oykoOS1vBIByrAfldTSTFLcRwtdhWVN2hDDaPY/oKZrDIuHmqgVRQiL8pMbkdZlg3FPxx1Z55AY1iEcUKf+hLI4e1d0orwbh9uBXc6srSb3dPFIBwd0bk3X+BrqViuwSYP7GozXxU4Hc5lS1qnDKXwuS5iOLG7IbkqZqs76BOhyPM4+wNIF2wtUdT6iJp//h+JT3R2EIGKDzqharmMT5B+6tC66xAx/UhelEdn6voN/A92ak+D1HfhE3MggSMaQAl4BQ17GmXRY2mERQuinUksYQEk3TwdEuYocMO8kubiUmPe1ZUPLzrx8xKUBLyTrB07dvOZQsBsN4XYBDR+hseUibFEqXMQ8A6XeWBkAO7XDY9j5Zcfwcmd0JGG1Atrsm1pegCMJOng0R0mtPdXklt71zLPLkiINSshBmCwnY0+qd1HHvm9OCJ9bgBK3+4BnXdjKMQ0IoYvHl1t5qXN60b+v4J2yvFJCzRHL/AD++SEkEkF8DHnIgfGEjEDmiqhK6iGyU8IebFpljSzbJxgFtMeBNCw7p/3KTahaTOrqEQy98m2xzjZc7jc8FXmhL51RkxO1nKI9kPFFugXzG6tQY9b8NYAW+HWSwv9P+NbUpAtNzqYmJ7qapupUGMTWNJFCLYxJF3IEWQNWyLF8NeAVDAd1re6IEFmcWQHUTVMOVU2XNwxeXeb2BnuBenhClg+9W+wDiXOmWP6PJR5xhvSqB7amaaxc0vTQIVuVBbWVJsukXg/L/yz+/qEIbk1ao5xPCh0qrAi7hvCAk0mQFDQITTKX/m++x7Q54raOJsXUL4rtIoWLcfvBP82RTCYcJtt6UJSBdiT5MAc0Rb5pGoNr/4p+UmBxqwTEhokq6wi/QLblp4rKXpbJBrZJ1ImRc3iUB72cUqZ7fzTkwWV6J2GjH/yJKcOW04SOCqRXNwGOIPnKUhWh5KI6KG1vdsqHa2927P7gY8mtNIGgDnyHdoKpdyk+urtEPKVD2nHITkhKQAJZoEMQnQDZyJsoFAiAcYHVM+PKTEPCyYfiBXws1ZToBlJsA7zZKdtj+n6vhcr00AGd6QtxEmDXnZ11iUk4y8Mpp+KvtDqOKVDMaJXgX01z/hYdY/mAGs9lidi1MGbdUL7bYTrUCSWrGdFXJc211pZ7tmN/unEtJRR1gGHONdIJJ5YMdSW1aSVUwigg1tdZEiggtKb3RhPEUG99bSYM+aW0orDggINxLFrIBAANAeUygZzuUURbp/8v78hxxg5AVPnk7W6wLdFUAApgR+LTDllB1tflBSyw6FyNJHA8cLFch1w2OuR5gO32TpXeYdVXGnM25BRmCvm/Rac1QD9Trozy/ZEUUJd3fijtk2E3p8YWGp3D6ZNcAm/lqBDnKS3T9bHsRPVEJJBDYc0GEZm7hmmuwceLjyrpTXxgBlAkIqMhE27VMYdj3yvaIKlwW8XaSA0HdCDf4gQGUjWE2hseB0MZWBxxZ9u7mY38cLdyOQkN2cOV167ivrQGPcym5KsxaEciuLXtiL4fai+i24auzNbs6IIIS1wTcEiKvDOxUErap4jj10JcMG1Iwqj5sCno/0osyLR+dQsysxRTKRa1NKzUpu4C5olqa2eEOXU+3UZZY1AeGm1U3XLs6z/rwvWdx49tEm76i8la0fAycC/Ql4qKxFBKxQ1agf2lLwjUqIProfGd9aiNx92JVCZUx+AieB7G5ZY5WuyQah717l+9vn/v1v6tm/tv/YpnP/z0Zv+3v/ZmT3v93/2h/6cb/V+9/93da/df/rZ/9frBt28d3Ly2997n4Dl/697ex98cfPXZ7tf3+vf+x+6dK/1r7/bfer3/5efgS//WNdaR8JiPLDqk014+vgLabefMl4+vOGCGZpgW4beTFGmSGlFmEBv0jzuhH8p6QYV6N9FaSQJbKl0qvZIrha1tRHDX069UzuGaq70oVgJcS83a8DGhOwIVM526QENLw6yR5KXSwAhRzpFRuTG0viBWZjQKmZKa6E/hfuKkqskTK2ihkcGP/i5pyqlOtKWjMPIoZxE6ztCYwxoaMxb0pM2U7gxtBla4TU1CyXKACpBbCAxZwuZt/JRV+bngVlNaWgIzezhVsHInyvML8y/Mnp5ZCBZmnptdXFp40dSS6bOMEruF4piD65WAO/hSr2dbM7xEEftUQ3M+itDGuQv/9YiGxPL7o71kjmWCH4+gBcQngHD9JJ2SQ6Ch3XRy/UyodIiUsFzkZuHcchOuHVe6yXjtR70pL9+gN3IZX9EOQciJ4pi7dkZJh4A9DlIuyLgE5lpzcQMyxxW5p9CC41Q60doauHhU3FxqBTDJaegsIUutjqI12pfSrIJQopivcMYq01KxUfTWiIEOay6mKzpQgOMvWhWJEKEjrKAGQfSoIUF37ZbeNg/D/0dcXwBBmiOPZZJbM/QAeOnyHXybY8Prk5D+o8Yk5PeBk0C1XJPYDJNwneoXZUVkhOXwWAMMrDsAV3w0awlFfAietoLMhRpaRWqLRRprnByEt+eJCM2x/IaeE8A6Z8RZbXnp8vsa6vIctmuLf1ytjE36lu5XuT8bKaQc2ZloOqGgDGc8f1BenWRKdAOyhqENHIVYSrrmrQd0vOxYJ5n/Ktfy88RkPWxvW/iQ6MCXzQqUBGkjJDUNoRxzMwyrbiSiEAscRgmFSX6BeelGFZ4mTaS6Mf1iaBaUdph0aG5HF60yF9IBlGoTokbEAkxBxll40bDHmInPovIbo4RUrg6atBSDPOk7Uzp4JKigMzl0W4hO6k7qMdRmLuLRKAPvJSsAaBAXtit/f1QxQE+orSenhdrPyPYMi7SSOXEaiELMUPrDkIgCj1rivkeCwVCI+pN8XZftZVqhyltWzRiNL2837TqWV2RA4qFUPEWV65gzzzBd7GsNFXQUSVDJNEoGpPdiiYgMUhEH3RDPcotMSojDud7qAghnAnhQDLhU8CBW+oyCeaugM6UlylGwPll+2DoOUlYJkMkCyaXvESK3AVcZWUs7wGiW3l6WwV3B4cGIr0HuSfPGg6CwMQujsogK6vClqbw1n2ZduYSiCpSm2NjWYrYMLMrEWGQR1zFxIFHBpKi8TH/DzpHV+CcTH3o3ZoCH7JDtMb0UpxhTC412lEwDDAEQcqC6PAfCTpAnYTffSAvzzhBthvRxh9IdgTm78CYu5/3SnVgTi/nG5fsUdnoJm3j4F5lDsRy5fxjrkrvAbYvWbjxNyLiV1xDF6Xakcs/RkmAKd8Iw7/B+mlXG0Q6gkXw63YAd1a/TU5Ku6rTcU03HOJ+ZVhs2ulGtqjctwKrhx+xvoKNvaesyv1VDa+shI2Ve0UWEnlI69phkZl8KwfQJlC7tlJCoKIS8R3R9TJRxYi8hKR3/MlmdyYvxdYMPhn2ZxDfjlofOGsPL2ZMu+9pelphx2nYVssALWyJxmacSlBjnfpdqEtblukQ8lXKppVLBXi02tBa6dPmS7pwSF8dRR9JFa43XVJafy7uwZBP51wDBwClY2/m25dIKwyislZ09CWk0W55xeA6ozHK8IGcfq+7Aucl+rMnRfkz5+uFfxfBRRh29jFaHu2/pvk4/KNEosVX2C9Ms1ckdgTYHteTSlrOdBZ2Ulo4CzaPe3kdv7L3zev93r+2//en933zDX8r74s8H//qZNDT33/z6/mvXv7t7bffr68w+3X/zX/p/+DWzW/Mcblc/3/36XWZu3v3mw/0/f7N/k5u0hfVZu5gNSFdsXRVwSlMWvcu1ZtYlYBD9PdiLHH2q8ODm7/tXr95/+b29uzfY1AFJd67vv/0pw2j/9c/6b13f/+CXe//8Tf/ujf3Pbu+/8uXBv/1q/8N39977172P3tj/4Jf7X/9h741veRG15OMEd04GPuTSiNZcXqUcV0d0R5MEY0hm8nvpDcLDuX45AVO3Hk7KvqRTXyX4yl2KuEk1GjcDrEVJB01Rrp0uVivRQ1qyWepQ3dir+efDk0lM0aALSepwoDTquhgt25Brdzna2sgEZsmvrYphFtLNlh0pMiaxpc4WzegkIw8NbyGc9VBtljAD9chQI7nugIPka4lEB+5Eqe1ywjQSyydWYBYKBgY6daoWY40M6hGALO/U5S1Vd8FOrX1JjXdKqxyfVNYe+lXYXM26T9OqVr4xDql88jn3ws3VaL2X9oTiurRNzrUsWzRtjNpPYZ5H69Sz8cHtJ02mFemnDrl5zXG0AB41T0cKLR68yx6UVdncdFRwLP/tsIG/b+kfckuzGUbsOSIJgq5JqDSO7dHmBEJ3+DI8KGX6k6Gul47GJb4KrvcvXQilhTITDfVXZQUD2JbOghDbU2il+9TJ+tSFYwD3E/p6KpYoFosK3XcxOwcOffsmTDpBRiDcSpdF0ev0mt6PKd95gBYvr7NM2hhTSH7livyytGo+65E/FWJllBTex1AJgS1etAvSLMj4c961NIvW4SE1mbcPGcehtjRe6a9B8xmVoAPJy5BkLzAeN2HPPYtJmm2U/YGNz+oNC9C09CV4MYxJlgeU0XTMHDUBcRh36UoMeBhdsnuW5U/0JdL91Zkvnj7EmNa7CPmgQrf7CSNtrvKlLBn9J6NpHShloYvutBCGLniEYNiM5EWqvQBd46psshWlvdwFN42QYsUi9G1y2EtChjlx+OtbEoAhM1KvALL9Tx1WQH+HnfoH5NPACDbzD5ZnS0TpVo6QPcPI8hJ2kAmCuTTY0W0ycCjKiyhZHyW7imhj5VdBWvl2IavV1eHu7MRIdCI7uaxSs+NXTERDw/JWkE0cNyeXDwosTSfltaxFyTN0Ujnd8i5fINvcWCqizhsq7Qp0g7XV4KgmjQ50xXjUzI6BRWjjsivpeFjmYNKDicM0Jum/FGnCGkIKnp6npuRn+XgDX+9lsdby8OMbgSR5LyMmKWnuHg3TusBvAN2M5CTbwvwg1/IwPlTTnIOomRHGJWvryLCIdzDtO4cVcas5nj2k8S/vBq7vWooE7u8oZ6Jll1Kh8L4K3NeCmRoqol2k9oD/D+MozJlErAdd8vxUWrYqlphP3ipYHjl7WSdFr01yqQDNzzKGDwO1ohSUtAlMhre1jZrUfE1LsdFa0SwFe8VOqE7N+NpLPqboPIl6kXm6Vspyq4vzQ4YhDLDwiFH1NmiXhtmFcs6st3LuUQymzA6vYcxIx+XGncqsSPM9LkzNLZ6fX1haXOZdyxzirvxUlpkW4qY0pJrm4RXbTqtYmAIfMathmYBctxUaTF9GpCIkYOAWdZjWl+UGQ5jnQ/K0/QPXFK2V4ZKw7OJFK4i+mAmHu1jpvlXyFz79ZTsmxAwHSwkB1QSGMeNctM8PxWNlfbvSsqgAM7l87FhN2YEHWmyFB0jDc5tqWcL3HXXbQXNit3V5dIX0EQcx+aS9kWYo7ycr5RdpWkilMfGnLccKzlCmyKLiHWvuDLcyf1v1uTyop+KlYJg1UYJh5MjEg1g9XFNXM5TozpDAT689IuB3XiQxN67g4DiXrONLPDVAaPoFmt6TqRbgSg+FCC5cap55pu9V/ejgjar5eWSQBsq5EEcFMiNxyP2FqASMReFD6RuhscF2pJXA/O4If6XyNFfglSn3NM315RobUR4qDQ6CYKN1Y050vjtc3zMq8ky9j35YmMmQcSpcU0oYdeTS7OtId8TtrwZ30uVqjTkJ1lKJn6kWKCkj5ma0bJYxE/m3ZmUQvNt72js39XOarP5sMHs6ODsz99zSGcAXbOg069TaG2FW937qTS1Oz84G0/NzSwvzZ4PpM1ML8JTmQnB29tzsErMeboQZdp+ojFqu0hKZRTFLGYGI5WCHJGatPRu3zMLmvK9W3qR2jPFlX7QDa4SrH017KMmj9OWOw9Oy0J/R61p3u9khpAt/fP/+liNc6oZn7ZEYf9Q7S6MbaCQUaPHDjOAnHEAB5YVr8DZ5RvI03oJLWQgXtLDNNdfieJV9sngJ4NyOV5gHOtc0hnizablIBgUDDPCq4Wk4eJCAdkQAK2DAa/bGkZmv7A66svwFhsjBOpmxPqTGXvyrIh8bxFNJq+HUX6griCeDTCqGVJW1GhhKo/Rm5TKHnIad9miItGLedkc/8czl1lVSCOX6UtruXI5VrHY9egCX80NcyiverWhdOPWF1YWbMXQ7NOUcjwh+OczSI6wKPFba9X6Yfk4gywniiCMeocbRh48846gDGIacbd4AXwR498+0BKLzUM/kXHMY0yjNi7OqMt/SJW6Xj4J2Eg83pVk2NFLX3vcqNx8Zm3CYGWbg/CicwuzkvBfjFw0fnPg57GVtqR63XvRo2M/3NpzvJ1dmVkKRtO2QaRCHKhNEOFU9ODnj7zIBTtpB5YLDC6XGIkoZganOVGYJpmXQ7Vsyx6wrJYPK4+DQNIolx5kZaFyWHHDSHty2zcqkpyPkQ1UPluuT0R7o9gc7FogHo3XXgsPsHyvDpTQ5aCkc3TlWXbvJyiZusWPPkcvGfLVP5LUJmKBOqIWjI2id19aPI/bNaw1uI15vRqyw5Z4G9w6ihaKK0gEb20CMTpURpY5YrJL5BsvhZbxq7HPgNrZ2mQak3GDmnGWqLfQkpbFjkBFfb642gDaWg/75D9maH6LuiTqkE7NhSXKiwehDpG+/fy7COdXEQVmC0NCCYLXxC2R7XL5EqMmOVRJbl2zQBzYJiwZ45niZH8g2q+HUhy4dne7/xrjrEALX2qwM2RQCtKNfeLCCD+c+bniSyepWGUOOQo/HW2/ekCxa27YYPbRgRQp3vKrMGw5hZtjjhBbjV07oB8vFVI+SnFChkunamqbG5hDDwZbHzXZGQAoWZkcxnbpZvUnffg420rzgiWH1IERRjUEXcDkSRpieWVgK5ubnZkyhnDdhp33oxFU7DNokK5xuLO0QIaUdymdfkE5o9963EO1y5Y3dO3+U5OHtf/DLg9sv7375b9/d/XDvvU/23nmd/RRRLtcPXr13//3r+1/9YffOV/e//ueDW7/b/fbm7tdf7//x3f13fo+DNoSfXjki2+FaFJNWmje7YbHRJJe6YdLp5aAskCDr0RXKKYs9A8yIbpiSeQj92peA8ruDdnW4fOwY7x+9NzlUKS2FF6mV5gfoQ1NM8/6PopvGz7Bbr69rj0+7pQb98WkGkDOnrslRG6M/vr4z4KqrVpaF2oz2eDp68xrRURXOV3e/gT0MQjH0jk30lmLt4dN92QM4wlvCN99313w0pGeGeGDGhyMr7ZLECBkXD95ryvlANi8fXx8Bj13ywo4wksnv9miOOgCxQizpUM/8B3Fp15/3CbNwkxRMIhTvedOolaKXyRk0VTXZMqWkRT3m6JvtaQ80O4ytnJ5dnJ5/YWbhxWBp9tzM/PNLweLM9Pzc6UXloAeJk6WLFJW55BCTou9l5ERVphLxhIbXLKXSn0PxcZT7mgCc046Ul0vhNyuu0KeUDLk6ps820Y9HBQ5JFhXYhWzWIWEHXl8Bkycwn800SYs0idq1uvf4sDVVNrswinsZTirkcf3tatpLOqSj6F1cBBveMcbv0h48v6WAxCFP4p91j2UcbTOMEuaqKKcxbk3DasdyM/GmP215EwL1SwwahnC73YWLYbZuUv1mlNTkLGS39R3XqGKJcFAR73XZRxjwmQlHCWj4Hzz67TlZBMLsMdZrnTrkc3WgjUD4t5p2tqnim1Vqgga8pqQEtfQLM4vn5+cWZ4JnXlyaWfQe9447MQsyB/SpCxtl3bhhqroRpHrW7IA7Wf0iT5MmKI9yClKzQ0BBWvN7xdr4j33HIzu2wgc7UXE+bZTyrC5hEcqw/qPNyr29ZS/sGI/S5jPbBcln5xm2tXqusAxHNIaHNq6IPGZhfW5FB5Lt927f2Pv4Zv+f7u1+/TsWwN7/6NP9X//7/me/9s5vFxtp4h18++H+p7/evfPHv155hYWz88zaXv+jP/U/vtL/8Lf3r1z57u41yJ/+3ucHt/7Uv/dO/+rn/bd+u/cmRGz3777Sv3On/+Xn999/q//65we3v+7fePf+azfwFSCvdk5bTGhAohBpC+Lv3lnymiY7HjvGGT6K64LzPTbDaaoB6hAPTMUvDtOnoCLy5I96GgmMciN8kS/hJ1+yhfBOTpz0+m+96T2xdRyuZ/ff+Mvex6/+9crLB59f3Xvv8/tvv39w+/be7bf/48pHu3eu7719e+/ay/sf3urfe+c/rny89+Ff+le/2L33G7wqHvV1DIERrvViqq+nwaRUX0//opkV+JHheC2EpQboZXEcrTbpr+aZpaXzLE2AJ3pptrFB5OTEyYZ3cuIppHnnWBMjCTZfQ7ABVLy4vjx+XG97aD4kIwqAHdBo/iYoXmlGKxrzgJ/LNQ2A0vHXFfIg79y4G8TJhKXNsmWWhIlptrnLx46JX0LWVmkDdBl8EW5opKNcR7Xrh3vlHGyosvIsIyxngU+fzlGrz1b+OKz8k9zlpYSVOhtykrEaaivKJ4Wlg9GFcSEx1Evx9PzC2QEx1+b2gIM6T5OGBtZIqsky2OAf3JKkAKmjBe4GxilxqH1SUadcbsl14Okhg43zuVZ1D38QMWLuaKPBoVWiDzO86hHlfsC37JDYMvfgtj+tnGhkRQFST0E8sghZxyEMevf8ZWjBjpx5TCvxOvHUtChclulTVla8xz31WWVQ0b87HIL1h34zskYykrRLsi+I4E1q1ary8Kvr0Vc9OY1Kcjk88wEbVwknZoKjEgzTBpziERsGGwiaLw/IZGMMCvM0DPmSXBNqEZT5S+00jZ601jAd+8CQLRXLgiBgQ6CTk48pcSMjSa0EgNGguYt+xeStXkref7eepperXT4WO/v5SNquYwG2mG6YZcBMd6/3bWwknoQzJ8L08FB9UX/4zGpUKlN+sCx7a60OCo/ypGsVXrG0gmFLH+l98M8Mq40ySdezGXY6KuhbyzUx5BUEA3CHE4fQtjfLnnyrABGnViiQQfCkCIo06MZhsZZmm8KaY2iKsc6ZQ2zkJxjoZi1MK1biesusIhQEVdPMPCLfEveriofmVAM9EYURMgfzYuQprLCCUErcq3Tk2Kl2S5gCO6/SXnuDdALEG7Se7Fp0fQ2QOQy63ll4hTInIcezy66tptoMyOuBjOlSOLDSe1SQI0dwDWQeNSoRhYRUD1++jLfWpIYDFbpl5mt11HGmmvD0J93xotDyHccqDEz+YKyituWwwtnhPo4C8Sulq1dUMYqTuUYryOLHNP+9IvV1EcIRScmqrSz7/IqYB1tRDkaxFTPVf9jtxtsBFxuPBgc8AiXTdgDH2eLvRD6We/lGmhXtXuFt9vKCefJuhJ30ogf9PJarjLtaj2IVGMtaYdg2p2Qimz1h4U4MqbtKPpyXgDTKBaWxHMWZb0sDhM2QG/ToWNb0EA+RzfTXExRg8tkEvDGq5OYpW3DuProlnmfBJD/IG1aVChpFX2jP6Le5wFoS62Hu4uLUoYTlsR68dtgNV6MYbN1ljuSHyUZUekdz+9ajp0YdFzb0KEf5pPhRKmfBk+sYdjznvc/Vr0qXf5FkhPdIH/bQOyyJChgkJWiC/KAL59AAAHBpQUK7A1LXOaGd584r1yNW2L7DYde8rHBKUFdfDXZDe2JnHdLCfaR9r5KUIBsglTh9S058x5tPRdDqvsI0nkRCZDs2DdlTSAQRFNglWR7lhSsoQw+N4H+6PTlcYorIg8WEEcstjObpPVQir0lH39qZKG/wKglV4pR93Fd6pz33SCmt5EwOldrq0HigWRq1GoKJHDnLmZ7czKECbpRIqPVJw153SHFWRF2XCj+T/D7PEhzrAgK/Qo38SAnukp3VKiGOOuXNCs7CXpcGjl2u4DzGDw3DfQy5qUxaTiY8EdT38WC4lZZUPXyjJ+HRayElq4Yv2URDmi5H0rsmbWM8KEWVutrD6iwCp+VVwbPLSW8wln9IJNOZDUcx5+W0NtdlDEu7/qjX/9X7e7+5vnvvo/63V+/f/JpZt1nC972Pb+5/eIvlOD949d7+259Ky/kXf9679gZ7qZyli4ek5zS3/P3ffMMynjNHWmGOFRHZ2oOVUpsqYcRCqq+/CoT93UWyRLSNNSYcrQkDhGDfzgekZMzWgIyKWItHP61YEoodvyV1vPS3++z2tAeXHhjL0k4RhnThU6FtDD60fjdQKjV/Uod9xzifYpcfjzGervxiYWl1k1Ij8ThZFame1ZHht48Kety9+8Huna/27361/9HL8nGDg5u/3/+fX/Vff+/g5qfg5H377YNvXu3furb3zl8kZfev3u3f+hKqXbkLrh5f3ei//l7/2rv9L271774iiDdy7yR2daBv+DpKDVg9p7gmvY2dkcE8VwGMI6x+g2/MHKHKAsI/qGf+HDtthao62EogTo1uqc7tabJsoyqjIu0xQHaEixrOM9xiEyzLry5SYsvVSO8Eyv1e6TmK6q9LMNIeFMppaxuGPkFR9uZJNPBZcvPhSPeDfqgvldu5M2luYDYvrYVaD8crlOXNhwzkPNVZy2oEr5nE3RRG/TzDOJbRtDxroZbR0n6G9P9vYlPZ1yu/VEqVEDaaGVRHoFzzvq0SkhtvnyKyG0w8xgO5UW5TjnJDwlzqUDSBDKwDsMAsrE4ElKhpkN6orp2kWRrLDOTdXtZNc6JPo4pODO7CrC3VLAoVmFS/HEFRxmUfl5bPGFVMUQ2L14pP0VqqQcdthUHh2TQ2YK3aJEF/UwEuJ2AwGNy/iRMyEWDGe3LLS1zHJoY9xEI/KKTqeskS4Ekb7i+9JE7bF0inpmdzpD+sbI5wQ2PxQjzAP0qcGdKK7S6hkiz7Q0yPVadETLphRqalJmYm2SIQn+NPougkVylviTVAhJfWuKu9FkfbIe1su6ulf8eAOsao1yWo4mHbVcJSaqgosPPiY9ihuampyXopPc91f6e5EsE8CaRVuvoDBoIPllo6uQDOu6YWo1VwDvLSVXCUdGAfKBAjunJ2NNSDc7qTKMPM6BZ8axR2mghl1Tl+KRJcvHoOQAf5patkWnL/8+pOppLADg1+G9arAe/QIFJ3f9iBQLijm6FvmmO6tRdduUzrMt6m9ZMJxllaoj89cav2Aoor0Yys4fB5Zn7D6MVTNoVD+Chjpo98kVGq9ZKayjt5RU8drnvMG55iLu95rogYQW+PF9NmHnbi2+qOKB57biYsyPo2z4yC64oivmwM/wC9kQdFm0ZpuCqO1LQjVsVYDi4BvPFws6SCV6fXpm4tRsI4KSHYpM6LmLOU+BtLraKtTJ0kRAik6/IbXPJwy0y8B8uXxBvR+wj+rZK1NCNDiX+gLFZ2K2B9V5QEqdwDw8ZRu/AtQV8FEA7JiOk4l6Q3B2sLiHOnvziqi5OkD9v0pFTYA1xbBgQCHd1DZkj2E/vVF6tXx7R0vYBu6LFfPR4mehhr/uBFkBGp/oelfLpoVVJcYv4jAgX46VQfOBn5dqelxK3kZaRoZ6DGxaVu0fmpJxyUnZieHKwztFXSgwGq2/uKk6Jr+Yc991VOskd79ktO6BBuLl6JaDBcJbBTkVtUt+U7+2JPNOngPlD2o4kA9PFLROOjHpGWvc869HWrX8Ow+VkOyW6zIL/v2no7IbWUPeVpyyDoVCp9lGBY3paKYrw1Ofdbnt5RpKa/BRnFrTRCOqORBmqHCeUmoBASDWxnP2cm/PK3GXOowDgNv0CRH0jO+htL3OxYYvfJWfnUPPKJefTT0uqBUq3DrG33xEgZ0W/145ZH2WH2rwHyiARk1IsPuscf4oHMONxc7YTstK9yUB72Ds5Q9axcrP83DiW18/7mDqW/89Lvn5dW5BcPYUcPtpMcbVP/fTP/4Ju5uqB4RMGMrbhDNKtI2t/jZnuo0bPeyK+5WGFlQ1uUOzRwfLDwUOO6qAluMtq2LJ4HzYGaGu3MZMPGA5XA0UJry8JXaS7hQ6khjek7XtKwnj7SX0Ry+SryKai4J2fAk123/DVLA72Dc1m4sm9LIqr21Ij45w4ZlL9c6h130gzpkDAoC4NzqcoRnFOsuR2XddRVnUZlpbQi8zrPTieo3t6CTj11lYA17wi6LfEYoeLhyGHGTGNkezq4g5qGvmRiB1p5Mn2fQFDleCSE45HDklDboSo/1/x/MCUffrIHEaGWgNChCFTzHUkH6AhMUwmYPOlDgj1RdAcUIDPLoUTZ7bjbBVcvNqy7nfzCTNS2H8EAnw0rI0eZqwybaUqFZOP1Cf/MzMK5mcXgzPy5GV88T2Fmnvb/8YkmywInXofLm5vhBdKJsrwG/TZYKp0gvYDuCzLrY010+Ys0Snh9vynjWcfpDhrnAgVAzt5f9WkqSPiNQsCLMGOvY5amzLy4EcXEEVTqjN9aaydF3FyDQWrwfw3+5ez89M+CmZ97/4B/zz1jH1+rGQkvuEj8GeguStZn5x0vDnDCsbKXjssJPu09NSy7quYHHqz2cvPtBTprGCKPCenWJpoTT1mXl1KSGZP46obbwJyN5JRhTk6dbK6eOskzVOaQTSFb31o+vlJ3Z62UbiFiH/GOWWk3i5Kitrg0tbCEP9AhO73Nbl677KcXeOo2SGLIuttpiLttmLejiEtDuIeZudP1sYrvMEFIWU3l0h4Q8EYvV1oQHc3Wxqek8YIyDyF1UEr43EtthFGWA5mKZgpK8LhgOcTkIAYjp93Vx/4PDxTEsxgKAQA=";


// ===================== 配置 =====================
const CFG = {
  bearer:        process.env.LIGHTVELA_BEARER || '',
  cookie:        process.env.LIGHTVELA_COOKIE || '',
  instanceId:    process.env.LIGHTVELA_INSTANCE_ID || '',
  botId:         process.env.LIGHTVELA_BOT_ID || '',
  region:        process.env.LIGHTVELA_REGION || 'ap-johorbahru',
  proxyHost:     process.env.LIGHTVELA_PROXY_HOST || '127.0.0.1',
  proxyPort:     parseInt(process.env.LIGHTVELA_PROXY_PORT || '9119', 10),
  hermesToken:   process.env.LIGHTVELA_HERMES_TOKEN || '',
  sessionId:     process.env.LIGHTVELA_SESSION_ID || '',
  env:           process.env.LIGHTVELA_ENV || '',
  apiBase:       process.env.LIGHTVELA_API_BASE || 'https://api.lightvela.ai',
  shellCmd:      '',        // --shell 模式：直接往沙箱 PTY 敲 shell 命令，拿【原始输出】(不经过机器人)
  shellWaitMs:   25000,     // --shell 模式收集输出的时长
  // ★ 出口代理：让纯代码走"环境代理"，做到账号隔离（出口 IP = 环境 IP）
  egressProxy:   null,      // 由 LIGHTVELA_EGRESS_PROXY(JSON) 解析而来
  noAutoclose:   process.env.LIGHTVELA_NO_AUTOCLOSE === '1',  // 1=跑完不自动关环境（由外层编排统一关）
};

// 解析出口代理。JSON 形如：{"type":"https","host":"1.2.3.4","port":8080,"username":"u","password":"p"}
// 支持 http / https / socks5；type=Direct 或字段缺失 → 保持 null（直连，行为同原来）。
if (process.env.LIGHTVELA_EGRESS_PROXY) {
  try {
    const p = normalizeProxy(JSON.parse(process.env.LIGHTVELA_EGRESS_PROXY));
    if (p) { CFG.egressProxy = p; console.log('[代理] 出口代理:', p.kind + '://' + p.host + ':' + p.port + (p.username ? ' (带认证)' : '')); }
    else { console.log('[代理] 环境未配置代理（直连）'); }
  } catch (e) { console.log('[代理] LIGHTVELA_EGRESS_PROXY 解析失败，按直连处理:', e.message); }
}
const EGRESS_AGENT = makeHttpsAgent(CFG.egressProxy);

// ===================== 通用小工具 =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// LightVela 后端统一返回 {code:"OK", data:{...}}；这里把 data 拆出来（data 缺失时原样返回）
function unwrapData(j) {
  if (j && typeof j === 'object' && j.data !== undefined) return j.data;
  return j;
}
// 从若干候选键里挑出第一个数组（兼容 items / passes / bundles 等不同字段名）
function pickArray(d, keys) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') for (const k of keys) if (Array.isArray(d[k])) return d[k];
  return null;
}
// 一个 pass 是否"有效"（未删除且未过期）
function passAlive(p) {
  if (!p || p.deleted_time) return false;
  if (!p.expired_time) return true;
  const t = new Date(p.expired_time).getTime();
  return !isNaN(t) ? t > Date.now() : true;
}

// Hermes 后端启动脚本（ensure_opencraft_hermes_backend），从 companion 前端 PtyStart 抓包提取。
// 前端原样：openPty({program:'/bin/sh', args:['-c', Vi() + ' exec /bin/sh -i']})
let PTY_START_FN = process.env.LIGHTVELA_PTY_FN || '';
if (!PTY_START_FN) {
  try { PTY_START_FN = require('./lv-ptystart-fn.js').ptyStartFn || ''; } catch (e) {
    console.log('[警告] 未找到 lv-ptystart-fn.js，PtyStart 将无法启动 Hermes 后端');
  }
}

// ===================== HubStudio 本地 API（仅用于成功后关环境） =====================
const HS_BASE = 'http://127.0.0.1:6873';
const HS_H = { 'Authorization': 'NULL', 'Accept-Language': 'zh-CN', 'Content-Type': 'application/json' };
async function stopBrowser(containerCode) {
  try {
    const r = await fetch(HS_BASE + '/api/v1/browser/stop', { method: 'POST', headers: HS_H, body: JSON.stringify({ containerCode }) });
    const j = await r.json();
    console.log('[HS] browser/stop', containerCode, '=>', JSON.stringify(j).slice(0, 120));
  } catch (e) { console.log('[HS] browser/stop 失败:', e.message); }
}

// ===================== BSON 编解码 =====================
// ★★ 2026-10-10 关键实证（推翻旧「自造 TLV」假设）★★
//   TAT 中继帧根本不是自造 TLV，而是【标准 BSON】（前端 a-DOq8azvI.js 里 sendBson() 调 bson 包的 serialize）。
//   已用实抓帧逐字节比对：用标准 BSON 重建的 PtyProxyNew 与抓包 225 字节 100% 一致。
//   帧结构：
//     { Type: "PtyProxyNew",
//       Data: { SessionId, ChannelId, CustomData: "",
//               Data: { ProxyId, Ip: "127.0.0.1", Port: "9119" } } }        ← PtyProxyNew（内层是 doc）
//     { Type: "PtyProxyData",
//       Data: { SessionId, ChannelId, CustomData: "",
//               Data: { ProxyId, Data: <BSON Binary, subtype 0 = 隧道原始字节> } } }
//   注意：Seq 字段只在【服务端→客户端】方向出现；客户端方向不带 Seq。
//   WebSocket 帧类型：BSON 帧 = 二进制(opcode 2)；SessionAuth/PtyStart/PtyStop 等 = 文本 JSON(opcode 1)。
function bsonI32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; }
function bsonCStr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0x00])]); }
// 0x02 字符串：len 含结尾 \0
function bsonStr(name, v) {
  const u = Buffer.from(String(v), 'utf8');
  return Buffer.concat([Buffer.from([0x02]), bsonCStr(name), bsonI32(u.length + 1), u, Buffer.from([0x00])]);
}
// 0x03 嵌套文档：直接把【整段文档字节(自带长度+结尾\0)】拼进去
function bsonDocEl(name, docBuf) { return Buffer.concat([Buffer.from([0x03]), bsonCStr(name), docBuf]); }
// 0x05 二进制：int32 长度 + 1 字节 subtype + 裸字节
function bsonBin(name, buf, sub = 0) { return Buffer.concat([Buffer.from([0x05]), bsonCStr(name), bsonI32(buf.length), Buffer.from([sub]), buf]); }
// 拼一个完整 BSON 文档：int32 总长(含自身与结尾\0) + 各元素 + 0x00
function bsonDoc(elements) {
  const body = Buffer.concat(elements);
  return Buffer.concat([bsonI32(body.length + 5), body, Buffer.from([0x00])]);
}
// 解码一个 BSON 文档 → {字段名: 值}（doc 递归、bin 保留 Buffer）
function bsonDecode(buf, start = 0) {
  const total = buf.readInt32LE(start);
  const end = start + total - 1;               // 去掉结尾 0x00
  const out = {};
  let i = start + 4;
  while (i < end) {
    const type = buf[i]; i += 1;
    const nul = buf.indexOf(0x00, i);
    if (nul === -1) break;
    const name = buf.slice(i, nul).toString('utf8'); i = nul + 1;
    if (type === 0x02) { const len = buf.readInt32LE(i); i += 4; out[name] = buf.slice(i, i + len - 1).toString('utf8'); i += len; }
    else if (type === 0x03) { const dl = buf.readInt32LE(i); out[name] = bsonDecode(buf, i); i += dl; }
    else if (type === 0x05) { const len = buf.readInt32LE(i); i += 4; const sub = buf[i]; i += 1; out[name] = buf.slice(i, i + len); out[name + '__sub'] = sub; i += len; }
    else if (type === 0x12) { out[name] = Number(buf.readBigInt64LE(i)); i += 8; }
    else if (type === 0x10) { out[name] = buf.readInt32LE(i); i += 4; }
    else if (type === 0x01) { out[name] = buf.readDoubleLE(i); i += 8; }
    else if (type === 0x08) { out[name] = buf[i] !== 0; i += 1; }
    else if (type === 0x0A) { out[name] = null; }
    else { out['__unknown'] = '0x' + type.toString(16) + '@' + (i - 1); break; }
  }
  return out;
}

// 从 PtyProxyData 帧里抽隧道 TCP 字节
// ★ 实测结构（服务端→客户端，BSON 解码确认）：
//   { Type, Seq, Data: { SessionId, ChannelId, CustomData, Data: { ProxyId, Data: <BSON Binary> } } }
//   即隧道字节在【三层】：fields.Data.Data.Data —— 少一层就会取到内层文档对象而非 Buffer。
function extractTunnelBytes(fields) {
  try {
    const inner = fields.Data && fields.Data.Data;          // 内层文档 {ProxyId, Data:<bin>}
    if (inner && Buffer.isBuffer(inner.Data)) return inner.Data;
    if (Buffer.isBuffer(fields.Data && fields.Data.Data)) return fields.Data.Data; // 兼容二层结构
    return null;
  } catch (e) { return null; }
}

// ===================== 最小 WebSocket 客户端（外层 TAT 中继用） =====================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
/**
 * 在裸 socket(tls/net) 上跑一个最小 WS 客户端。
 * 自动处理握手、掩码发送、解帧。返回 {send, close} 并回调 onOpen/onMessage/onClose/onError。
 */
function createWSConn({ host, port, path, useTls, proxy }, handlers) {
  let sock = null;
  let destroyed = false;
  const key = crypto.randomBytes(16).toString('base64');
  let hsDone = false;
  let buf = Buffer.alloc(0);
  let frags = [];          // 接收侧分片拼接（文本/二进制）
  let fragOp = 0;

  function parseFrames() {
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
      let mask = null;
      if (masked) { if (buf.length < p + 4) break; mask = buf.slice(p, p + 4); p += 4; }
      if (buf.length < p + len) break;
      let payload = buf.slice(p, p + len);
      if (masked) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i % 4]; payload = o; }
      buf = buf.slice(p + len);
      if (opcode === 0x8) { handlers.onClose && handlers.onClose(); sock.end(); return; }
      if (opcode === 0x9) { sock.write(Buffer.from([0x8a, len])); continue; } // ping -> pong
      if (opcode === 0xa) continue;                                            // pong
      if (opcode === 0x0) { frags.push(payload); if (b0 & 0x80) { const full = Buffer.concat(frags); frags = []; handlers.onMessage && handlers.onMessage(full, fragOp); } }
      else { if (b0 & 0x80) { handlers.onMessage && handlers.onMessage(payload, opcode); } else { frags.push(payload); fragOp = opcode; } }
    }
  }

  // ★ 2026-10-10 修复(实测卡死根因)：TLS 连接必须在 secureConnect 后才能发 WS 升级请求；
  //   若在 'connect'(仅 TCP 建立、TLS 尚未握手完) 时 write，请求会丢失 → 中继不回 101 → onOpen 永不触发。
  //   非 TLS 仍用 'connect'。
  const writeHandshake = () => {
    console.log('[WS] ' + (useTls ? 'TLS 就绪' : 'TCP 已连接') + ' → 发 WS 升级请求 ' + host + ':' + port + path);
    const req =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    sock.write(req);
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!hsDone) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const header = buf.slice(0, idx).toString();
      if (!/101/.test(header)) { handlers.onError && handlers.onError(new Error('WS 握手失败: ' + header.split('\r\n')[0])); sock.end(); return; }
      buf = buf.slice(idx + 4);
      hsDone = true;
      handlers.onOpen && handlers.onOpen();
    }
    parseFrames();
  };
  const attach = (s, readyEvent) => {
    sock = s;
    s.on('data', onData);
    s.on('error', (e) => handlers.onError && handlers.onError(e));
    s.on('close', () => handlers.onClose && handlers.onClose());
    if (readyEvent) s.on(readyEvent, writeHandshake);
  };

  // ★ 出口代理：经环境代理钻隧道后再握手，做到出口 IP = 环境 IP（账号隔离）
  if (proxy) {
    console.log('[WS] 经出口代理连接 ' + host + ':' + port + '  ←  ' + proxy.kind + '://' + proxy.host + ':' + proxy.port);
    connectTunnel({ proxy, targetHost: host, targetPort: port }).then((raw) => {
      if (destroyed) { try { raw.destroy(); } catch (_) {} return; }
      if (useTls) {
        const t = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false });
        attach(t, 'secureConnect');
      } else {
        attach(raw, null);
        writeHandshake();     // 裸 socket 经代理后已连通，直接发 WS 握手
      }
    }).catch((e) => handlers.onError && handlers.onError(e));
  } else {
    const s = useTls ? tls.connect(port, host, { rejectUnauthorized: false }) : net.connect(port, host);
    attach(s, useTls ? 'secureConnect' : 'connect');
  }

  return {
    send(data, opcode = 0x2) {
      if (!sock) { console.log('[WS] 连接尚未就绪，丢弃一帧'); return; }
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const len = b.length;
      const mask = crypto.randomBytes(4);
      let header;
      if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = b[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    },
    close() { destroyed = true; try { if (sock) sock.write(Buffer.from([0x88, 0x00])); } catch (e) {} try { if (sock) sock.end(); } catch (e) {} },
  };
}

// 内层 Hermes 不需要单独 socket——它走隧道字节流。下面两个函数直接操作"隧道收包缓冲"。
function wsEncodeClientFrame(text) {
  // 生成一条【带掩码】的文本帧（客户端→服务端必须掩码）
  const b = Buffer.from(text, 'utf8');
  const len = b.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = b[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
// 从隧道 TCP 缓冲里解【服务端发来、不掩码】的 WS 帧，返回 {msgs, rest}
function wsParseServerFrames(buf) {
  const msgs = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 2) break;
    const b0 = buf[i], b1 = buf[i + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = i + 2;
    if (len === 126) { if (buf.length - i < 4) break; len = buf.readUInt16BE(i + 2); p = i + 4; }
    else if (len === 127) { if (buf.length - i < 10) break; len = Number(buf.readBigUInt64BE(i + 2)); p = i + 10; }
    if (masked) p += 4; // 理论上服务端不掩码，但兜底跳过
    if (buf.length - i < p + len) break;
    const payload = buf.slice(p, p + len);
    i = p + len;
    if (opcode === 0x1 || opcode === 0x2) msgs.push(payload.toString('utf8'));
    // 忽略 ping/pong/close/continuation（内层简单场景够用）
  }
  return { msgs, rest: buf.slice(i) };
}

// ===================== REST 引导 =====================
function httpsReq(method, path, { bearer = CFG.bearer, cookie = CFG.cookie, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(CFG.apiBase + path);
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = Object.assign({
      'User-Agent': 'Mozilla/5.0 LightVelaPureCode',
      'Accept': 'application/json',
    }, headers);
    if (bearer) h['Authorization'] = 'Bearer ' + bearer;
    if (cookie) h['Cookie'] = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h, agent: EGRESS_AGENT }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('REST 超时(20s): ' + method + ' ' + path)); });
    if (data) req.write(data);
    req.end();
  });
}

// 确保拿到 Bearer（没显式传 LIGHTVELA_BEARER 时，用 cookie 走 /auth/session 换）
async function ensureBearer() {
  if (CFG.bearer) return CFG.bearer;
  const r = await httpsReq('GET', '/auth/session');
  if (r.json && r.json.token) CFG.bearer = r.json.token;
  else if (r.json && r.json.data && r.json.data.token) CFG.bearer = r.json.data.token;
  else if (r.headers['authorization']) CFG.bearer = r.headers['authorization'].replace(/^Bearer /, '');
  if (!CFG.bearer) throw new Error('拿不到 Bearer token，请手动设置 LIGHTVELA_BEARER 或 LIGHTVELA_COOKIE');
  console.log('[REST] 已获取 Bearer');
  return CFG.bearer;
}

// ===================== 纯代码：订阅 / 创建机器人 =====================
/**
 * 纯代码订阅 1 个月免费套餐（等价浏览器里"点 Free Trial → Confirm activation"）。
 *
 * ★ 2026-10-12 网站改版后实测（测试环境 1889133402 浏览器真实点击抓包）：
 *   老接口 POST /v1/passes 已废 —— 服务端只认已下线的 bundle_free_trial_01，一律 400。
 *   真实可用的免费开通 = 新版前端"点石下单即付"：
 *     POST /v1/passes/dianshi/order-and-pay { bundle_id:"bundle_launch_ai_01", period:1, time_unit:"m" }
 *   免费包是 **bundle_launch_ai_01**（Launch AI，0 元，首单免费 1 个月，送 4500 积分）。
 *   ⚠️ 别用 bundle_launch_01（非 AI 版）：同样 0 元，但走这条会卡在
 *      "paid_pending_provision / jifei returned no deals"，永不生效。
 * 成功判据：开通后 GET /v1/passes 能查到"未过期且未删除"的 pass（轮询等待生效）。
 * 失败一律返回 SUBSCRIBE=RETRY，由外层编排重订。
 * 输出：SUBSCRIBE=OK|already|<bundle>  /  SUBSCRIBE=OK|activated|<bundle>  /  SUBSCRIBE=RETRY|<原因>
 */
async function restSubscribe() {
  await ensureBearer();

  const fetchLivePasses = async () => {
    const rp = await httpsReq('GET', '/v1/passes');
    const list = pickArray(unwrapData(rp.json), ['passes', 'items']) || [];
    return list.filter(passAlive);
  };
  const brief = (r) => {
    const code = String((r.json && (r.json.code || r.json.error_code || r.json.error)) || '');
    const msg = String((r.json && (r.json.message || r.json.msg)) || r.text || '').replace(/\s+/g, ' ').slice(0, 160);
    return { code, msg };
  };
  const isOk = (r, code) => r.status >= 200 && r.status < 300 && (code === '' || code === 'OK');

  // 0) 已有有效订阅 → 直接成功（幂等）
  try {
    const live = await fetchLivePasses();
    if (live.length) {
      const b = live[0].bundle_id || '';
      console.log('[订阅] 已有有效订阅:', live.map((p) => p.bundle_id || '?').join(','), '（无需重复激活）');
      console.log('SUBSCRIBE=OK|already|' + b + '|' + (live[0].pass_id || ''));
      return true;
    }
  } catch (e) { console.log('[订阅] 查询现有订阅失败(忽略，继续尝试激活):', e.message); }

  // 1) 组装候选套餐：显式覆盖 → 0 元包（AI 优先）→ 实测有效的免费包 → 老包兜底
  const candidates = [];
  const push = (id) => { if (id && candidates.indexOf(id) < 0) candidates.push(id); };
  push(process.env.LIGHTVELA_BUNDLE_ID);
  try {
    const rb = await httpsReq('GET', '/v1/bundles');
    const bs = pickArray(unwrapData(rb.json), ['bundles', 'items']) || [];
    const online = bs.filter((b) => !b.bundle_state || b.bundle_state === 'ONLINE');
    const zero = online.filter((b) => b.price && Number(b.price.real_total_cost) === 0);
    zero.sort((a, b) => (b.bundle_type === 'ai' ? 1 : 0) - (a.bundle_type === 'ai' ? 1 : 0));
    for (const b of zero) push(b.bundle_id);
  } catch (e) { console.log('[订阅] 拉取套餐列表失败(用默认清单):', e.message); }
  push('bundle_launch_ai_01'); // ★ 实测有效的 0 元免费包（Launch AI）
  push('bundle_launch_01');    // 非 AI 版（可能卡开通，仅作兜底）
  console.log('[订阅] 候选套餐:', candidates.join(', '));

  // 开通后轮询等 pass 生效
  const waitPass = async (bundleId, tries) => {
    for (let i = 0; i < tries; i++) {
      await sleep(i === 0 ? 800 : 1500);
      try {
        const live = await fetchLivePasses();
        if (live.length) {
          console.log('[订阅] ✅ 复核通过，有效订阅:', live[0].bundle_id || bundleId);
          console.log('SUBSCRIBE=OK|activated|' + (live[0].bundle_id || bundleId) + '|' + (live[0].pass_id || ''));
          return true;
        }
      } catch (e) { console.log('[订阅] 复核查询失败:', e.message); }
    }
    return false;
  };

  // 2) 逐个候选尝试：新版"点石下单即付"优先，老接口兜底
  let lastErr = '';
  for (const bundleId of candidates) {
    // 2a) 新版（网站真实在用的那条）
    try {
      const r = await httpsReq('POST', '/v1/passes/dianshi/order-and-pay', { body: { bundle_id: bundleId, period: 1, time_unit: 'm' } });
      const { code, msg } = brief(r);
      console.log('[订阅] dianshi/order-and-pay', bundleId, '→', r.status, 'code=' + (code || '-'), 'msg=' + msg);
      if (isOk(r, code)) {
        if (await waitPass(bundleId, 8)) return true;
        lastErr = '订单已建但未生效(' + bundleId + ')';
      } else { lastErr = msg || ('HTTP ' + r.status); }
    } catch (e) { console.log('[订阅] dianshi 请求异常:', e.message); lastErr = e.message; }

    // 2b) 老接口（对遗留免费包仍可能有效）
    try {
      const r2 = await httpsReq('POST', '/v1/passes', { body: { bundle_id: bundleId } });
      const { code, msg } = brief(r2);
      console.log('[订阅] POST /v1/passes', bundleId, '→', r2.status, 'code=' + (code || '-'), 'msg=' + msg);
      if (isOk(r2, code)) {
        if (await waitPass(bundleId, 8)) return true;
      }
      if (/conflict|already|exist|duplicate|已订阅|已存在|重复/i.test(code + ' ' + msg)) {
        console.log('SUBSCRIBE=OK|already|' + bundleId + '|');
        return true;
      }
      lastErr = msg || ('HTTP ' + r2.status);
    } catch (e) { console.log('[订阅] 老接口请求异常:', e.message); lastErr = e.message; }
  }

  console.log('SUBSCRIBE=RETRY|' + (lastErr || '所有候选套餐均未开通'));
  return false;
}

/**
 * 纯代码创建机器人（等价浏览器里"填/不填表单 → 点 Create"）。
 * 有现成实例就直接复用；没有就 POST /v1/instances，再轮询到 active。
 * 输出：BOT=<instance_id>|status=<status>[|reused=1]  /  BOT=FAIL|<原因>
 */
async function restCreateBot(name) {
  await ensureBearer();

  // 0) 已有可用实例 → 复用
  try {
    const ri = await httpsReq('GET', '/v1/instances');
    const items = pickArray(unwrapData(ri.json), ['items', 'instances']) || [];
    const act = items.find((x) => /active|running/i.test(String(x.status || '')));
    if (act) {
      const iid = act.instance_id || act.id;
      console.log('[建Bot] 复用已有实例:', iid, '状态=' + (act.status || ''));
      console.log('BOT=' + iid + '|status=' + (act.status || 'active') + '|reused=1');
      return true;
    }
  } catch (e) { console.log('[建Bot] 查询现有实例失败(忽略):', e.message); }

  // 1) 直接创建实例（注：后端【没有】 /v1/instances/create-prerequisites 这个接口，
  //    实测返回 NOT_FOUND，纯属多打一次请求 + 日志噪音，已于 2026-10-10 去掉）

  // 2) 创建实例
  const nm = String(name || '').trim() || ('agent-' + crypto.randomBytes(3).toString('hex'));
  let rc;
  try { rc = await httpsReq('POST', '/v1/instances', { body: { timeout: 3600, name: nm } }); }
  catch (e) { console.log('BOT=FAIL|请求异常:' + String(e.message).slice(0, 100)); return false; }
  const d = unwrapData(rc.json) || {};
  console.log('[建Bot] POST /v1/instances →', rc.status, JSON.stringify(rc.json || {}).slice(0, 240));
  let iid = d.instance_id || d.id || '';
  let status = String(d.status || '');
  if (!iid) {
    const msg = String((rc.json && (rc.json.message || rc.json.msg || rc.json.code)) || rc.text || '').replace(/\s+/g, ' ').slice(0, 140);
    console.log('BOT=FAIL|' + (msg || ('HTTP ' + rc.status)));
    return false;
  }

  // 3) 轮询等它变成 active/running（最多 ~60s）
  for (let i = 0; i < 20 && !/active|running/i.test(status); i++) {
    await sleep(3000);
    try {
      const r2 = await httpsReq('GET', '/v1/instances');
      const its = pickArray(unwrapData(r2.json), ['items', 'instances']) || [];
      const hit = its.find((x) => (x.instance_id || x.id) === iid);
      if (hit && hit.status) status = String(hit.status);
    } catch (e) { /* 忽略单次查询失败 */ }
  }
  console.log('[建Bot] 实例=' + iid + ' 最终状态=' + status + ' 名称=' + nm);
  console.log('BOT=' + iid + '|status=' + (status || 'unknown') + '|name=' + nm);
  return /active|running|creating|pending/i.test(status) || !!iid;
}

// ===================== 设主模型（纯代码复刻前端【Set as primary model】）=====================
// 失败即抛错（方案甲）：不设主模型机器人不会回话，部署无意义，按方案C保留环境等排查。
async function restSetPrimaryModel(instanceId) {
  if (process.env.LIGHTVELA_NO_SET_MODEL) {
    console.log('[模型] 跳过设主模型 (LIGHTVELA_NO_SET_MODEL=1)');
    return;
  }
  // payload：前端点【Set as primary model】时实际下发的动作（Auto 行）
  const payload = Buffer.from(JSON.stringify({
    type: 'assign',
    providerKey: 'custom',
    modelId: 'auto',
    baseUrl: 'https://token.lightvela.ai/v1',
    purpose: 'primary',
  })).toString('base64');

  // 引导 python：解压并执行 HERMES_MODEL_CFG_SCRIPT_B64，把 sys.argv[1] 设为 payload（与前端一致）
  const bootstrap = 'import base64,gzip,linecache,sys;path="<stdin>";source=gzip.decompress(base64.b64decode(sys.argv[2])).decode("utf-8");linecache.cache[path]=(len(source),None,source.splitlines(True),path);sys.argv=[sys.argv[0],sys.argv[1]];exec(compile(source,path,"exec"),{"__name__":"__main__"})';

  // 前端下发的 shell 命令外壳（设 HERMES_ROOT / HERMES_PYTHON，失败兜底 python3）
  const command =
    'set -e\n' +
    'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"\n' +
    'export HERMES_ROOT\n' +
    'HERMES_PROFILE_ROOT="${HERMES_HOME:-$HOME/.hermes}"\n' +
    'export HERMES_HOME="$HERMES_PROFILE_ROOT"\n' +
    'HERMES_PYTHON="$HERMES_ROOT/hermes-agent/venv/bin/python"\n' +
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="python3"; fi\n' +
    'printf \'%s\n\' \'' + bootstrap + "' | \"$HERMES_PYTHON\" - \"" + payload + "\" \"" + HERMES_MODEL_CFG_SCRIPT_B64 + "\"";

  console.log('[模型] 设主模型: custom/auto (POST /v1/instances/' + instanceId + '/debug/exec)');
  const r = await httpsReq('POST', '/v1/instances/' + instanceId + '/debug/exec', {
    body: { command: command, run_as_user: 'agentuser', execution_backend: 'tat' },
  });
  if (!r.json || r.json.code !== 'OK') {
    throw new Error('debug/exec HTTP 层失败: ' + (r.text || '').slice(0, 240));
  }
  const data = r.json.data || {};
  const output = typeof data.output === 'string' ? data.output : '';
  const m = output.match(/__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_START__([\s\S]*?)__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_END__/);
  if (!m) {
    throw new Error('debug/exec 未返回模型配置结果(实例内脚本可能报错): ' + output.slice(0, 300));
  }
  let res;
  try { res = JSON.parse(m[1].trim()); } catch (e) { throw new Error('模型配置结果非 JSON: ' + m[1].slice(0, 200)); }
  if (!res.ok) {
    throw new Error('设主模型被实例拒绝: ' + JSON.stringify(res).slice(0, 240));
  }
  const snap = res.snapshot || {};
  const p = snap.primary || {};
  console.log('[模型] 主模型已设为: ' + (p.id || '?') + '@' + (p.providerKey || '?') + ' (' + (p.apiMode || '') + ')');
}

async function restBootstrap() {
  // 1) 拿 Bearer
  await ensureBearer();
  // 2) 实例（真实响应：{"code":"OK","data":{"items":[{instance_id,...}]}} —— 取 data.items）
  if (!CFG.instanceId) {
    const r = await httpsReq('GET', '/v1/instances');
    const dj = (r.json || {}).data;
    const list = (dj && dj.items) || (Array.isArray(dj) ? dj : null) || (r.json || {}).instances || [];
    if (!list.length) throw new Error('实例列表为空: ' + (r.text || '').slice(0, 200));
    CFG.instanceId = list[0].instance_id || list[0].id || list[0];
    console.log('[REST] 实例:', CFG.instanceId);
  }
  // 3) bot（真实响应：{"code":"OK","data":{"items":[{bot_id,...}]}}）
  //    ⚠️ 2026-10-10 实测：/v1/instances/{id}/bots 从外部请求会挂起(无响应)，故加 try 兜底；
  //    拿不到时直接用 instanceId 当 botId（实测两者同值，且 Hermes 只认 instance）。
  if (!CFG.botId) {
    try {
      const r = await httpsReq('GET', `/v1/instances/${CFG.instanceId}/bots`);
      const dj = (r.json || {}).data;
      const list = (dj && dj.items) || (Array.isArray(dj) ? dj : null) || (r.json || {}).bots || [];
      if (list.length) { CFG.botId = list[0].bot_id || list[0].id || list[0]; console.log('[REST] bot:', CFG.botId); }
    } catch (e) {
      console.log('[REST] /bots 不可用(' + String(e.message).slice(0, 70) + ')，兜底用 instanceId 作 botId');
    }
    if (!CFG.botId) { CFG.botId = CFG.instanceId; console.log('[REST] bot(兜底=instance):', CFG.botId); }
  }
  // 4) tat/session —— 拿 TAT 中继连接参数
  const r = await httpsReq('POST', `/v1/instances/${CFG.instanceId}/tat/session`, { body: {} });
  if (!r.json) throw new Error('tat/session 响应非 JSON: ' + r.text.slice(0, 200));
  const t = r.json.data || r.json;
  return {
    appId:     t.appId,
    uin:       t.uin || t.ownerUin || t.loginUin,
    instanceId: t.instanceId || CFG.instanceId,
    sessionId: t.sessionId || CFG.sessionId,
    wsUrl:     t.wsUrl || `wss://${CFG.region}.forward.tat-tc.tencent.cn/ws`,
    poolId:    t.poolId,
    username:  t.username,
    region:    t.region,
  };
}

// ===================== 隧道 + Hermes 会话管理 =====================
let rpcId = 1;
const pending = new Map();          // id -> {resolve, reject}
const eventHandlers = [];           // 全局事件回调
function onEvent(cb) { eventHandlers.push(cb); }

async function runChat(message) {
  const tat = await restBootstrap();
  if (!CFG.sessionId && tat.sessionId) CFG.sessionId = tat.sessionId;

  // 建 Bot 后进聊天界面需手动做的【模型设置】，改为纯代码自动设主模型（--shell 验证模式跳过）
  if (!CFG.shellCmd) {
    try {
      // ★ 2026-10-12 修正：必须用 LightVela 的实例号(CFG.instanceId)，不能用 tat.instanceId！
      //   tat/session 返回的 instanceId 是【腾讯云 TAT 中继侧】的短号(如 ins-r7y4y9dh)，
      //   只用于 TAT WS 的 SessionAuth；拿它去打 /v1/instances/<id>/debug/exec 会 404 resource not found。
      await restSetPrimaryModel(CFG.instanceId || tat.instanceId);
    } catch (e) {
      throw new Error('设主模型失败（机器人将无回应，部署无意义）：' + e.message);
    }
  }

  // 解析 TAT wsUrl
  const u = new URL(tat.wsUrl);
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'wss:' ? 443 : 80);

  let outer = null;                 // 外层 TAT WS 连接
  let tunnelBuf = Buffer.alloc(0);  // 隧道收包缓冲（内层 Hermes TCP 流）
  let hermesOpen = false;
  let ptyReadySeen = false;
  let proxySent = false;            // PtyProxyNew 是否已发出（避免重复开通道）
  let ptyOutBuf = '';               // PTY 输出累积（找 __LV_DASHBOARD_READY__:<token>）
  let hermesToken = CFG.hermesToken;
  let shellActive = false;          // --shell 模式：是否已切到"原始命令行"
  let shellOut = '';                // --shell 模式：原始输出累积

  // 把一段 TCP 字节经 PtyProxyData 发到隧道（BSON 二进制帧）
  function sendTunnel(tcpBytes) {
    const frame = bsonDoc([
      bsonStr('Type', 'PtyProxyData'),
      bsonDocEl('Data', bsonDoc([
        bsonStr('SessionId', CFG.sessionId),
        bsonStr('ChannelId', CFG.proxyChannel),
        bsonStr('CustomData', ''),
        bsonDocEl('Data', bsonDoc([
          bsonStr('ProxyId', CFG.proxyChannel),
          bsonBin('Data', tcpBytes),
        ])),
      ])),
    ]);
    outer.send(frame);
  }
  // 对内层 Hermes 发一条 JSON-RPC（经隧道）
  function hermesSend(method, params) {
    const rpc = { jsonrpc: '2.0', id: rpcId++, method, params: params || {} };
    const p = new Promise((resolve, reject) => { pending.set(rpc.id, { resolve, reject }); setTimeout(() => { if (pending.has(rpc.id)) { pending.delete(rpc.id); reject(new Error('RPC 超时: ' + method)); } }, 20000); });
    sendTunnel(wsEncodeClientFrame(JSON.stringify(rpc)));
    return p;
  }

  // 处理内层 Hermes WS 收到的文本（JSON-RPC 事件/响应）
  let replyText = '';
  let curMsg = '';        // 当前这条消息已累计的增量（用于与 message.complete 的全文去重）
  let gotMessageStart = false;
  function handleHermesText(text) {
    let msg; try { msg = JSON.parse(text); } catch (e) { console.log('[Hermes] 非 JSON:', text.slice(0, 120)); return; }
    if (process.env.LIGHTVELA_DEBUG) console.log('[Hermes][帧]', JSON.stringify(msg).slice(0, 260));
    // —— JSON-RPC 响应（有 id + result/error）——
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
      return;
    }
    // —— 事件帧：{ method:'event', params:{ type, session_id, payload, seq } }（实抓确认）——
    //   文本字段对齐前端 Ft()：payload.text ?? reasoning ?? content ?? message
    const evType = (msg.params && msg.params.type) || msg.method || '';
    const pl = (msg.params && msg.params.payload) || {};
    const txt = (typeof pl.text === 'string' && pl.text) || (typeof pl.reasoning === 'string' && pl.reasoning)
              || (typeof pl.content === 'string' && pl.content) || (typeof pl.message === 'string' && pl.message) || '';
    if (evType === 'message.start') { gotMessageStart = true; curMsg = ''; }
    else if (evType === 'message.delta') { if (txt) { curMsg += txt; replyText += txt; process.stdout.write(txt); } }
    else if (evType === 'message.complete') {
      // complete 里的 text 是整条消息全文；补上增量没覆盖到的尾部（避免重复，也不丢字）
      if (txt && txt.length > curMsg.length) {
        const extra = txt.slice(curMsg.length);
        replyText += extra; process.stdout.write(extra);
      }
      curMsg = '';
    }
    eventHandlers.forEach((cb) => cb(msg));
  }

  // 外层 TAT WS
  outer = createWSConn({ host, port, path: u.pathname + u.search || '/ws', useTls: u.protocol === 'wss:', proxy: CFG.egressProxy }, {
    onOpen() {
      console.log('[TAT] 中继已连接，发送 SessionAuth(文本 JSON 帧)');
      // ★ 实测抓包（2026-10-10 env A 现场，CDP 重载重连）：SessionAuth 是【文本帧 opcode=1 的 JSON】，
      //   不是二进制 TLV。真实帧：
      //   {"Type":"SessionAuth","Data":{"Uin":"100045199955","AppId":1388575217,
      //    "InstanceId":"ins-kfgu6elv","SessionId":"<uuid>","MaxIdleTime":3600}}
      //   注意：AppId / MaxIdleTime 是【数字】，Uin / InstanceId / SessionId 是【字符串】。
      const authJson = {
        Type: 'SessionAuth',
        Data: {
          Uin: String(tat.uin),
          AppId: Number(tat.appId),
          InstanceId: String(tat.instanceId),
          SessionId: String(CFG.sessionId),
          MaxIdleTime: 3600,
        },
      };
      outer.send(JSON.stringify(authJson), 0x1);   // 0x1 = 文本帧
      // 建代理通道到 Hermes 后端（通道号先定下来）
      CFG.proxyChannel = 'proxy_lvpure_' + crypto.randomBytes(4).toString('hex');
      // ★ 关键时序（对齐前端 a-LNlbm_te.js 的 Hi()）：必须【先 PtyStart 启动 Hermes 后端、拿到 session token】，
      //   再 PtyProxyNew 开隧道。后端启动后会在 PTY 输出里打印 `__LV_DASHBOARD_READY__:<token>`，
      //   该 token 就是 Hermes WS 的 ?token= 凭据。
      //   若不先启动后端：隧道能开(PtyProxyReady)但连 9119 会立刻被关闭(PtyProxyClose)——即上一轮的失败现象。
      setTimeout(() => sendPtyStart(), 400);
    },
    onMessage(data, opcode) {
      // —— 诊断日志（仅 LIGHTVELA_DEBUG=1 时打印，避免刷屏）——
      if (process.env.LIGHTVELA_DEBUG) {
        if (opcode === 0x1) {
          let txt = ''; try { txt = data.toString('utf8'); } catch (e) {}
          console.log('[TAT][RECV text]', txt.slice(0, 240));
        } else {
          const f = bsonDecode(data);
          console.log('[TAT][RECV bin] type=', f.Type || '', 'keys=', Object.keys(f).join(','));
        }
      }
      // —— 正式处理 ——
      if (opcode === 0x1) {
        let j = null; try { j = JSON.parse(data.toString('utf8')); } catch (e) {}
        if (!j || !j.Type) return;
        // ★ PTY 相关帧（PtyReady/PtyOutput/PtyError）都是【文本 JSON】，不是二进制 BSON——实抓已确认。
        //   PtyOutput 的 Data.Output 是 base64 终端文本，其中含 __LV_DASHBOARD_READY__:<token>。
        if (j.Type === 'PtyReady') { console.log('[TAT] PTY 就绪'); return; }
        if (j.Type === 'PtyOutput') { handlePtyOutput(j); return; }
        if (j.Type === 'PtyError') { console.log('[TAT] PtyError:', JSON.stringify(j).slice(0, 300)); return; }
        if (j.Type === 'PtyProxyReady') {
          ptyReadySeen = true;
          console.log('[TAT] 代理通道就绪(text):', (j.Data && j.Data.ProxyId) || CFG.proxyChannel);
          setTimeout(() => { connectHermes(); }, 500);
          return;
        }
        if (j.Type === 'PtyProxyClose') { console.log('[TAT] 通道关闭(text)'); return; }
        return;
      }
      // 二进制帧 = BSON 文档（PtyProxyReady / PtyProxyData / PtyProxyClose）
      const fields = bsonDecode(data);
      const type = fields.Type || '';
      if (type === 'PtyProxyReady') {
        ptyReadySeen = true;
        console.log('[TAT] 代理通道就绪(bin):', (fields.Data && fields.Data.ProxyId) || CFG.proxyChannel);
        // 等 800ms 让后端先推送 token 横幅（__LV_DASHBOARD_READY__:<token>），再发 WS 握手
        setTimeout(() => { connectHermes(); }, 800);
      } else if (type === 'PtyProxyData') {
        const tcp = extractTunnelBytes(fields);
        if (!tcp) { console.log('[TAT][数据] PtyProxyData 结构:', JSON.stringify(fields, (k, v) => Buffer.isBuffer(v) ? ('<buf ' + v.length + '>') : v).slice(0, 600)); return; }
        if (!hermesOpen) console.log('[TAT][隧道] 收到 ' + tcp.length + ' 字节: ' + JSON.stringify(tcp.slice(0, 200).toString('utf8')));
        // token 可能出现在隧道 TCP 输出里（后端启动打印 __LV_DASHBOARD_READY__ 或 token: xxx）
        if (!hermesToken) {
          const s = tcp.toString('utf8');
          const m = s.match(/__LV_DASHBOARD_READY__[:=]\s*([A-Za-z0-9_\-]+)|token[:=]\s*["']?([A-Za-z0-9_\-]{6,})/i);
          if (m) { hermesToken = m[1] || m[2]; console.log('[Hermes] 从隧道输出解析到 token:', hermesToken); }
        }
        tunnelBuf = Buffer.concat([tunnelBuf, tcp]);
        // 握手未完成时，先尝试解析 HTTP 101
        if (!hermesOpen) {
          const idx = tunnelBuf.indexOf('\r\n\r\n');
          if (idx !== -1) {
            const head = tunnelBuf.slice(0, idx).toString();
            if (/101/.test(head)) {
              hermesOpen = true;
              tunnelBuf = tunnelBuf.slice(idx + 4);
              console.log('[Hermes] WS 握手成功(101)');
              afterHermesOpen();
            } else {
              const echo = tunnelBuf.slice(0, Math.min(tunnelBuf.length, 200)).toString('utf8').replace(/\r?\n/g, ' ').slice(0, 200);
              console.log('[Hermes] 隧道首包非 101，预览:', echo);
            }
          }
        }
        if (hermesOpen) {
          const { msgs, rest } = wsParseServerFrames(tunnelBuf);
          tunnelBuf = rest;
          msgs.forEach(handleHermesText);
        }
      } else if (type === 'PtyProxyClose') {
        console.log('[TAT] 通道关闭(bin)', JSON.stringify(fields).slice(0, 400));
      } else if (type === 'PtyReady') {
        console.log('[TAT] PTY 就绪');
      } else if (type === 'PtyOutput') {
        const txt = ptyOutputText(fields);
        if (txt) {
          ptyOutBuf = (ptyOutBuf + txt).slice(-4096);
          const m = ptyOutBuf.match(/__LV_DASHBOARD_READY__:([A-Za-z0-9_\-]+)/);
          if (m && !hermesToken) {
            hermesToken = m[1];
            console.log('[Hermes] 已从 PTY 输出拿到 session token:', hermesToken);
            if (!proxySent) { proxySent = true; sendPtyProxyNew(); }
          }
          const em = ptyOutBuf.match(/__LV_DASHBOARD_ERROR__:([a-z_]+)/);
          if (em) console.log('[TAT] 后端启动报错标记:', em[1]);
        }
      } else if (type === 'PtyError') {
        console.log('[TAT] PtyError:', JSON.stringify(fields).slice(0, 300));
      }
    },
    onClose() { console.log('[TAT] 连接关闭'); },
    onError(e) { console.error('[TAT] 错误:', e.message); },
  });

  // 发一条文本 JSON 帧（等价前端 sendJson：SessionAuth / PtyStart / PtyStop / PtyInput 等）
  function sendTextJson(obj) { outer.send(JSON.stringify(obj), 0x1); }

  // 往 PTY 敲内容（前端 sendPtyInput：{Type:'PtyInput', Data:{SessionId, Input:<base64 文本>}}，文本帧）
  function sendPtyInput(text) {
    console.log('[Shell] → 发送 PtyInput');
    sendTextJson({
      Type: 'PtyInput',
      Data: { SessionId: CFG.sessionId, Input: Buffer.from(String(text), 'utf8').toString('base64') },
    });
  }

  // PtyOutput 文本提取（对齐前端 f()）：Data.Output / Data.Data 是 base64，解出来是终端文本
  function ptyOutputText(fields) {
    const d = fields && fields.Data; if (!d) return '';
    const cands = [d.Output, d.Data, d.Data && d.Data.Output, d.Data && d.Data.Data];
    for (const v of cands) {
      if (typeof v === 'string' && v) {
        if (/^[A-Za-z0-9+/=\s]+$/.test(v)) { try { return Buffer.from(v, 'base64').toString('utf8'); } catch (e) {} }
        return v;
      }
      if (Buffer.isBuffer(v) && v.length) return v.toString('utf8');
    }
    return '';
  }

  // ★ --shell 模式：完全绕开机器人，直接往沙箱 PTY 敲 shell 命令，拿【原始输出】
  //   触发有两条路：① 见到 __LV_DASHBOARD_READY__ 标记（后端刚启动）；② 超时兜底（后端已在跑时不会再打印标记）
  function startShellMode(why) {
    if (shellActive) return;
    shellActive = true;
    console.log('[Shell] 进入原始命令行(' + why + ')，1.5s 后发送：' + JSON.stringify(CFG.shellCmd));
    setTimeout(() => sendPtyInput(CFG.shellCmd + '\n'), 1500);
    setTimeout(() => {
      console.log('\n[Shell] ======== 原始输出结束（共 ' + shellOut.length + ' 字符）========');
      process.exit(0);
    }, CFG.shellWaitMs + 1500);
  }

  // 处理 PtyOutput（文本 JSON 帧）：Data.Output 是 base64 终端文本
  function handlePtyOutput(j) {
    const d = j && j.Data; if (!d) return;
    let txt = '';
    for (const v of [d.Output, d.Data]) {
      if (typeof v === 'string' && v) { try { txt = Buffer.from(v, 'base64').toString('utf8'); } catch (e) { txt = v; } break; }
    }
    if (!txt) return;
    ptyOutBuf = (ptyOutBuf + txt).slice(-4096);
    if (shellActive) { shellOut += txt; process.stdout.write(txt); }   // --shell 模式：原样打印
    const m = ptyOutBuf.match(/__LV_DASHBOARD_READY__:([A-Za-z0-9_\-]+)/);
    if (m && !hermesToken) {
      hermesToken = m[1];
      console.log('[Hermes] 已从 PTY 输出拿到 session token:', hermesToken);
      if (CFG.shellCmd) { startShellMode('后端已就绪'); }
      else if (!proxySent) { proxySent = true; sendPtyProxyNew(); }
    }
    const em = ptyOutBuf.match(/__LV_DASHBOARD_ERROR__:([a-z_]+)/);
    if (em) console.log('[TAT] 后端启动报错标记:', em[1]);
  }

  // 启动 Hermes 后端：PtyStart（文本 JSON，Program/Args 完全对齐前端）
  // 后端就绪后会在 PTY 输出里打印 `__LV_DASHBOARD_READY__:<token>`
  function sendPtyStart() {
    if (!PTY_START_FN) { console.log('[TAT] 无 PTY 启动函数，跳过 PtyStart，直接开代理通道'); proxySent = true; return sendPtyProxyNew(); }
    console.log('[TAT] 发送 PtyStart（启动 Hermes 后端，函数长度 ' + PTY_START_FN.length + '）');
    sendTextJson({
      Type: 'PtyStart',
      Data: {
        SessionId: CFG.sessionId,
        ChannelId: '',
        Cols: 120,
        Rows: 32,
        UserName: 'agentuser',
        Cwd: '/home/agentuser',
        Envs: {},
        Program: '/bin/sh',
        // ★ 注意：lv-ptystart-fn.js 抓下来的函数【结尾已带 `exec /bin/sh -i`】，不要再拼一次，
        //   否则 sh 会把多出来的 `exec` 当成脚本文件名 → `/bin/sh: 0: cannot open exec`。
        Args: ['-c', PTY_START_FN],
      },
    });
    // --shell 模式兜底：后端已在跑时不会再打印 ready 标记，8s 后照样敲命令
    if (CFG.shellCmd) setTimeout(() => startShellMode('8s 超时兜底'), 8000);
    // 兜底：12s 内既没拿到 token 也没开通道，就先用空 token 开通道试一把
    setTimeout(() => {
      if (CFG.shellCmd) return;
      if (!ptyReadySeen && !proxySent) { console.log('[TAT] 12s 未见 ready 标记，先开代理通道（空 token 试探）'); proxySent = true; sendPtyProxyNew(); }
    }, 12000);
  }

  // 发送 PtyProxyNew：标准 BSON 二进制帧（已与实抓 225 字节逐字节对齐，无需文本兜底）
  function sendPtyProxyNew() {
    const frame = bsonDoc([
      bsonStr('Type', 'PtyProxyNew'),
      bsonDocEl('Data', bsonDoc([
        bsonStr('SessionId', CFG.sessionId),
        bsonStr('ChannelId', CFG.proxyChannel),
        bsonStr('CustomData', ''),
        bsonDocEl('Data', bsonDoc([
          bsonStr('ProxyId', CFG.proxyChannel),
          bsonStr('Ip', CFG.proxyHost),
          bsonStr('Port', String(CFG.proxyPort)),
        ])),
      ])),
    ]);
    console.log('[TAT] 发送 PtyProxyNew(BSON 二进制帧, ' + frame.length + ' 字节)');
    outer.send(frame);
  }

  // 诊断看门狗：60s 内若通道未就绪，打印统计并退出（后端启动可能耗时，故给足时间）
  setTimeout(() => {
    if (!hermesOpen) {
      console.log('[WATCHDOG] 60s 内未建立 Hermes 通道，诊断结束。ptyReadySeen=' + ptyReadySeen + ' hermesOpen=' + hermesOpen + ' token=' + (hermesToken ? '有' : '无'));
      process.exit(2);
    }
  }, 60000);

  // 连接 Hermes：发 WS 握手（无论有无 token 都发，便于观察后端反应并捕获 token）
  function connectHermes() {
    const token = hermesToken || '';
    console.log('[Hermes] 发送 WS 握手 (token=' + (token ? '已就位' : '缺失, 试探') + ')');
    const handshake =
      `GET /api/ws?token=${token} HTTP/1.1\r\n` +
      `Host: ${CFG.proxyHost}:${CFG.proxyPort}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    sendTunnel(Buffer.from(handshake, 'utf8'));
  }

  async function afterHermesOpen() {
    // 镜像前端初始交互：先 ping
    try { await hermesSend('gateway.ping', {}); } catch (e) {}
    // ★ 关键：prompt.submit 要的是【活的 live session_id】，不是 session.list 里的持久 id
    //   （用持久 id 会被回 {"code":4001,"message":"session not found"}）。
    //   对齐前端 startThread：session.create({cwd, source:'desktop'}) → 取返回的 session_id。
    let sessionId = null;
    try {
      const c = await hermesSend('session.create', { cwd: '/home/agentuser', source: 'desktop' });
      const r = c.result || {};
      console.log('[Hermes] session.create →', JSON.stringify(r).slice(0, 300));
      sessionId = r.session_id || null;
    } catch (e) { console.log('[Hermes] session.create 失败:', e.message); }
    if (!sessionId) { console.error('拿不到 live session_id，无法发送消息'); return; }
    console.log('[Hermes] live session_id =', sessionId);

    // 发消息
    console.log('\n[发送]', message);
    process.stdout.write('[回复] ');
    try {
      const sub = await hermesSend('prompt.submit', { session_id: String(sessionId), text: message, queued: true });
      console.log('\n[Hermes] prompt.submit →', JSON.stringify(sub.result || sub.error || {}).slice(0, 200));
    } catch (e) { console.log('\n[Hermes] prompt.submit 异常:', e.message); }
    // 等待整轮回复结束。判据（对齐前端 settle 逻辑，按优先级）：
    //   ① 收到 `session.info` 且 payload.running===false 且已经出现过 message.start → 本轮真正结束（最可靠）
    //   ② 收到 `message.complete` 且随后 idleMs 内无新事件
    //   ③ 兜底：idleMs 静默 或 超过 maxMs 总时长
    //   注意：部署类任务 agent 会跑工具，中途可能长时间无输出，故 idle 默认给到 90s。
    const idleMs = parseInt(process.env.LIGHTVELA_IDLE_MS || '90000', 10);
    const maxMs = parseInt(process.env.LIGHTVELA_MAX_MS || '900000', 10);
    await new Promise((res) => {
      const t0 = Date.now();
      let last = Date.now();
      let sawStart = false;
      let done = false;
      let timer = null;
      const finish = (why) => { if (!done) { done = true; if (timer) clearInterval(timer); console.log('[Hermes] 本轮结束(' + why + ')'); res(); } };
      timer = setInterval(() => {
        if (Date.now() - t0 > maxMs) return finish('总时长上限');
        if (Date.now() - last > idleMs) return finish('静默超时');
      }, 500);
      onEvent((m) => {
        const p = (m && m.params) || {};
        const ty = p.type || m.method || '';
        if (ty === 'message.start') sawStart = true;
        if (ty === 'session.info' && sawStart && p.payload && p.payload.running === false) return finish('running=false');
        last = Date.now();
      });
    });
    // 部署成败判定：去空白后再匹配，规避 LightVela 按词拆元素渲染导致词间插空格的误判
    const flat = (replyText || '').replace(/\s+/g, '');
    const ok = flat.includes('部署完成，探针服务运行正常');
    console.log('\n[回复全文长度]', (replyText || '').length, '| [部署成功判定]', ok);
    console.log('RESULT=' + (ok ? 'OK|deploy_success' : 'FAIL|no_success_phrase'));
    outer.close();
    if (ok && CFG.env && !CFG.noAutoclose) { await stopBrowser(CFG.env); console.log('[环境已关闭]', CFG.env); }
    else if (ok && CFG.env && CFG.noAutoclose) { console.log('[环境保持打开] LIGHTVELA_NO_AUTOCLOSE=1，由外层编排统一关闭'); }
    process.exit(ok ? 0 : 1);
  }
}

// ===================== 入口 =====================
async function main() {
  const args = process.argv.slice(2);
  const msgArg = (args.find((a) => a === '--message') && args[args.indexOf('--message') + 1]) || '';
  const repl = args.includes('--repl');
  const envArg = args.includes('--env') ? args[args.indexOf('--env') + 1] : null;
  const shellArg = args.includes('--shell') ? args[args.indexOf('--shell') + 1] : '';
  const waitArg = args.includes('--shell-wait') ? parseInt(args[args.indexOf('--shell-wait') + 1], 10) : 0;
  const subArg = args.includes('--subscribe');                                   // 纯代码订阅（REST）
  const createBotArg = args.includes('--create-bot');                            // 纯代码创建机器人（REST）
  const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : ''; // 创建机器人时的名字
  if (envArg) CFG.env = envArg;
  if (shellArg) CFG.shellCmd = shellArg;
  if (waitArg > 0) CFG.shellWaitMs = waitArg;

  // ★ 纯代码子命令：只走 REST（同样经环境代理），不建隧道、不聊天
  if (subArg) { const ok = await restSubscribe(); process.exit(ok ? 0 : 1); }
  if (createBotArg) { const ok = await restCreateBot(nameArg); process.exit(ok ? 0 : 1); }

  if (!msgArg && !repl && !shellArg) {
    console.log('用法: node lightvela-purecode.js --message "你想说的话" [--env <containerCode>]');
    console.log('      node lightvela-purecode.js --repl   (交互聊天)');
    console.log('      node lightvela-purecode.js --shell "命令" [--shell-wait 25000]   (直连沙箱 shell，拿原始输出)');
    console.log('      node lightvela-purecode.js --subscribe                            (纯代码订阅 1 个月免费套餐)');
    console.log('      node lightvela-purecode.js --create-bot [--name 机器人名]          (纯代码创建机器人)');
    process.exit(1);
  }
  await runChat(shellArg ? '(shell 模式)' : (msgArg || '你好'));
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
