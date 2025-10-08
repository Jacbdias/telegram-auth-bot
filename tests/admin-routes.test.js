const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createAdminRouter } = require('../web/admin-routes');

function createMockDb() {
  let sequence = 1;
  const admins = [];

  return {
    admins,
    async getAdminUserByUsername(username) {
      return admins.find((admin) => admin.username === username) || null;
    },
    async listAdminUsers() {
      return admins.map((admin) => ({
        id: admin.id,
        username: admin.username,
        created_at: admin.created_at,
        updated_at: admin.updated_at,
        last_login: admin.last_login
      }));
    },
    async createAdminUser(username, passwordHash) {
      const now = new Date().toISOString();
      const admin = {
        id: sequence++,
        username,
        password_hash: passwordHash,
        created_at: now,
        updated_at: now,
        last_login: null
      };
      admins.push(admin);
      return { ...admin };
    },
    async updateAdminUserPassword(id, passwordHash) {
      const admin = admins.find((item) => item.id === Number(id));

      if (!admin) {
        return null;
      }

      admin.password_hash = passwordHash;
      admin.updated_at = new Date().toISOString();
      return { ...admin };
    },
    async deleteAdminUser(id) {
      const index = admins.findIndex((item) => item.id === id);
      if (index !== -1) {
        admins.splice(index, 1);
      }
      return true;
    },
    async countAdminUsers() {
      return admins.length;
    },
    async touchAdminLastLogin(id) {
      const admin = admins.find((item) => item.id === id);
      if (admin) {
        admin.last_login = new Date().toISOString();
      }
    },
    // Métodos não utilizados nos testes, mas necessários pela interface do router
    async getStats() {
      return {};
    },
    async getAllSubscribers() {
      return [];
    },
    async getSubscriberById() {
      return null;
    },
    async createSubscriber() {
      return {};
    },
    async updateSubscriber() {
      return true;
    },
    async revokeUserAccess() {
      return true;
    },
    async getAllChannels() {
      return [];
    },
    async createChannel() {
      return {};
    },
    async updateChannel() {
      return true;
    },
    async deleteChannel() {
      return true;
    },
    async getAuthorizationLogs() {
      return [];
    },
    async getSubscriberByEmailAndPhone() {
      return null;
    }
  };
}

const passwordUtils = {
  async hashPassword(password) {
    return `hashed:${password}`;
  },
  async verifyPassword(password, hash) {
    return hash === `hashed:${password}`;
  }
};

function createApp() {
  const db = createMockDb();
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ db, passwords: passwordUtils }));
  return { app, db };
}

function request(app, { method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();

      const req = http.request(
        {
          port,
          path,
          method,
          headers
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: data
            });
          });
        }
      );

      req.on('error', (error) => {
        server.close();
        reject(error);
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  });
}

test('permite criar e listar administradores via API', async () => {
  const { app, db } = createApp();

  const createResponse = await request(app, {
    method: 'POST',
    path: '/api/admin/admins',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer admin:admin123'
    },
    body: JSON.stringify({ username: 'novo-admin', password: 'senhaSegura1' })
  });

  assert.equal(createResponse.status, 201);
  const createdBody = JSON.parse(createResponse.body);
  assert.equal(createdBody.success, true);
  assert.equal(createdBody.admin.username, 'novo-admin');

  const storedAdmin = db.admins.find((admin) => admin.username === 'novo-admin');
  assert.ok(storedAdmin, 'novo administrador armazenado');
  assert.equal(storedAdmin.password_hash, 'hashed:senhaSegura1');

  const duplicateResponse = await request(app, {
    method: 'POST',
    path: '/api/admin/admins',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer admin:admin123'
    },
    body: JSON.stringify({ username: 'novo-admin', password: 'outraSenha123' })
  });

  assert.equal(duplicateResponse.status, 409);
  const duplicateBody = JSON.parse(duplicateResponse.body);
  assert.equal(duplicateBody.error, 'Usuário já cadastrado');

  const listResponse = await request(app, {
    method: 'GET',
    path: '/api/admin/admins',
    headers: {
      authorization: 'Bearer admin:admin123'
    }
  });

  assert.equal(listResponse.status, 200);
  const listBody = JSON.parse(listResponse.body);
  assert.equal(listBody.length, 2); // admin padrão + novo cadastro
  assert.deepEqual(
    listBody.map((admin) => admin.username).sort(),
    ['admin', 'novo-admin']
  );
});
