<div align="center">

# StarDraw ✨

**AI-Powered Content Generation Platform**

Create stunning images and videos with AI. Built for creators, designed for scale.

[![GitHub stars](https://img.shields.io/github/stars/rant-ha/stardraw?style=for-the-badge&logo=github)](https://github.com/rant-ha/stardraw/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/rant-ha/stardraw?style=for-the-badge&logo=github)](https://github.com/rant-ha/stardraw/network/members)
[![License](https://img.shields.io/badge/license-ISC-blue?style=for-the-badge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)

</div>

---

## 🌟 Overview

StarDraw is a modern AI SaaS platform that empowers users to generate high-quality visual content through an intuitive interface. The platform features a credit-based billing system, membership tiers, and supports both image and video generation.

### Key Capabilities

- 🎨 **AI Image Generation** - Create product images, artwork, and marketing visuals
- 🎬 **AI Video Generation** - Generate promotional videos with Sora2 integration
- 💳 **Points System** - Flexible credit-based billing with reserve/charge/release pattern
- 👑 **Membership Tiers** - Free and premium plans with monthly bonus credits
- 📜 **Generation History** - Track all creations with automatic 30-day retention
- 🔐 **Secure Auth** - Authing integration for reliable authentication

---

## 🛠️ Tech Stack

| Frontend | Backend | Infrastructure |
|----------|---------|----------------|
| React 19 | Express 5 | Docker |
| Vite 7 | PostgreSQL | Aliyun OSS |
| Tailwind CSS 4 | JWT Auth | Nginx |
| React Router 7 | Winston Logger | GitHub Actions |

---

## 📐 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (React 19)                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │Dashboard│ │AI Image │ │AI Video │ │ History │           │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘           │
│       └────────────┴────────────┴────────────┘              │
│                         │ REST API                           │
└─────────────────────────┼───────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────┐
│                    Backend (Express 5)                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ AI Controller│ │Points Service│ │Membership Svc│        │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘        │
│         └────────────────┴────────────────┘                 │
│                         │                                    │
└─────────────────────────┼───────────────────────────────────┘
                          │
┌────────────┐ ┌──────────┴──────────┐ ┌────────────────────┐
│ PostgreSQL │ │   Aliyun OSS        │ │   AI Providers     │
│  Database  │ │   Object Storage    │ │ (Nano Banana/Sora) │
└────────────┘ └─────────────────────┘ └────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Aliyun OSS account (or compatible S3 storage)

### Installation

```bash
# Clone the repository
git clone https://github.com/rant-ha/stardraw.git
cd stardraw

# Install server dependencies
cd server && npm install

# Install client dependencies
cd ../client && npm install

# Set up environment variables
cp server/.env.example server/.env
cp client/.env.example client/.env
```

### Environment Variables

**Server (.env)**
```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgres://user:password@localhost:5432/stardraw

# Aliyun OSS
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=your-bucket
OSS_ACCESS_KEY_ID=your-key-id
OSS_ACCESS_KEY_SECRET=your-secret

# AI Providers
IMAGE_PROVIDER_KEY=your-image-provider-key
SORA_API_KEY=your-sora-key

# Authing
AUTHING_APP_ID=your-app-id
AUTHING_APP_HOST=https://your-app.authing.cn
```

**Client (.env)**
```env
VITE_AUTHING_APP_ID=your-app-id
VITE_AUTHING_DOMAIN=https://your-app.authing.cn
VITE_AUTHING_REDIRECT_URI=http://localhost:5173/callback
VITE_BASE_URL=http://localhost:5000
```

### Run Development Servers

```bash
# Terminal 1 - Backend
cd server && npm run server

# Terminal 2 - Frontend
cd client && npm run dev
```

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up --build
```

---

## 📡 API Endpoints

### AI Routes (`/api/ai`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/scenes` | List available AI templates |
| POST | `/estimate-points` | Calculate required credits |
| POST | `/generate-scene-image` | Generate image from prompt |
| POST | `/generate-sora-video` | Submit video generation task |
| GET | `/video-status/:id` | Poll video task status |

### User Routes (`/api/user`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/get-user-creations` | List user's generations |
| GET | `/creations/:id/download` | Get download URL |

### Points Routes (`/api/points`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/balance` | Get account balance |
| POST | `/purchase` | Purchase credits |

---

## 🗃️ Database Schema

Key tables:

- `user_point_accounts` - Credit balances and membership tier
- `creations` - Generated content metadata
- `point_ledger` - Transaction history
- `prompt_templates` - AI scene configurations
- `generation_charge_rules` - Pricing rules

Run migrations:
```bash
psql -d stardraw -f server/migrations/001_full_schema.sql
```

---

## 🎯 Features Roadmap

- [x] AI Image Generation
- [x] AI Video Generation (Sora2)
- [x] Points Billing System
- [x] Membership Tiers
- [x] Aliyun OSS Storage
- [ ] Real-time generation progress (WebSocket)
- [ ] Team collaboration
- [ ] API rate limiting dashboard
- [ ] Webhook notifications

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Original project structure inspired by [QuickAI](https://github.com/elyse502/QuickAI)
- Built with React 19, Express 5, and modern web technologies
- AI capabilities powered by Nano Banana 2 and Sora2

---

<div align="center">

**StarDraw** - Create with AI, Scale with Confidence

[⬆ Back to Top](#-overview)

</div>
