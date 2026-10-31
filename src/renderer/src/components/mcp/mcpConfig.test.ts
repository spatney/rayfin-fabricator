import { describe, expect, it } from 'vitest'
import { joinCommandLine, parseConfig, serverSummary, splitCommandLine } from './mcpConfig'

const servers = (text: string) => {
  const result = parseConfig(text)
  if ('error' in result) throw new Error(result.error)
  return result.servers
}

describe('parseConfig', () => {
  it('reads a server out of an mcpServers block, as most instructions show it', () => {
    const [chart] = servers(`{
      "mcpServers": {
        "mcp-server-chart": { "command": "npx", "args": ["-y", "@antv/mcp-server-chart"], "env": { "VIS_REQUEST_SERVER": "https://vis.example" } }
      }
    }`)
    expect(chart).toEqual({
      name: 'Chart',
      transport: 'stdio',
      commandLine: 'npx -y @antv/mcp-server-chart',
      url: '',
      env: [{ name: 'VIS_REQUEST_SERVER', value: 'https://vis.example' }],
      headers: []
    })
  })

  it('reads VS Code’s configuration with comments, leaving placeholders to fill in', () => {
    const [github, linear] = servers(`{
      // GitHub's remote server
      "servers": {
        "github": {
          "type": "http",
          "url": "https://api.githubcopilot.com/mcp/",
          "headers": { "Authorization": "Bearer \${input:github_token}", "X-MCP-Toolsets": "issues", },
        },
        "linear": { "type": "sse", "url": "https://mcp.linear.app/sse" },
      },
      /* inputs are asked for */
      "inputs": []
    }`)
    expect(github).toMatchObject({
      name: 'Github',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/'
    })
    expect(github.headers).toEqual([
      { name: 'Authorization', value: '' },
      { name: 'X-MCP-Toolsets', value: 'issues' }
    ])
    expect(linear).toMatchObject({ name: 'Linear', transport: 'sse' })
  })

  it('reads one server’s entry, a server object, a URL or a command line', () => {
    expect(servers(`"learn": { "url": "https://learn.microsoft.com/api/mcp" },`)[0]).toMatchObject({
      name: 'Learn',
      transport: 'http',
      url: 'https://learn.microsoft.com/api/mcp'
    })
    expect(servers('{ "name": "Docs", "url": "https://example.com/mcp/sse" }')[0]).toMatchObject({
      name: 'Docs',
      transport: 'sse'
    })
    expect(servers('https://mcp.linear.app/mcp')[0]).toMatchObject({
      name: 'Linear',
      transport: 'http'
    })
    expect(servers('npx -y @antv/mcp-server-chart')[0]).toMatchObject({
      name: 'Chart',
      transport: 'stdio',
      commandLine: 'npx -y @antv/mcp-server-chart'
    })
    expect(servers('uvx mcp-server-fetch')[0].name).toBe('Fetch')
    expect(servers('docker run -i --rm ghcr.io/github/github-mcp-server')[0].name).toBe('Github')
    expect(
      servers(
        '{ "mcpServers": { "Playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }'
      )[0].name
    ).toBe('Playwright')
  })

  it('leaves values to fill in where the instructions have placeholders', () => {
    const [server] = servers(
      '{ "command": "npx", "args": ["-y", "server"], "env": { "API_KEY": "<YOUR_API_KEY>", "TOKEN": "YOUR_TOKEN_HERE", "REGION": "eu" } }'
    )
    expect(server.env).toEqual([
      { name: 'API_KEY', value: '' },
      { name: 'TOKEN', value: '' },
      { name: 'REGION', value: 'eu' }
    ])
  })

  it('says why it can’t read something', () => {
    expect(parseConfig('  ')).toEqual({ error: 'Paste a configuration first.' })
    expect(parseConfig('{ "mcpServers": ')).toHaveProperty('error')
    expect(parseConfig('{ "theme": "dark" }')).toEqual({
      error: 'That configuration doesn’t have a server with a command or a URL.'
    })
  })
})

describe('command lines', () => {
  it('split on spaces outside quotes and keep Windows paths', () => {
    const words = splitCommandLine(
      `node "C:\\Program Files\\server\\index.js" --name 'a "b"'  --empty ""`
    )
    expect(words).toEqual([
      'node',
      'C:\\Program Files\\server\\index.js',
      '--name',
      'a "b"',
      '--empty',
      ''
    ])
    expect(splitCommandLine(joinCommandLine(words[0], words.slice(1)))).toEqual(words)
  })

  it('summarize what a server runs, or where it is', () => {
    expect(
      serverSummary({ transport: 'stdio', command: 'npx', args: ['-y', '@antv/mcp-server-chart'] })
    ).toBe('npx -y @antv/mcp-server-chart')
    expect(serverSummary({ transport: 'http', url: 'https://learn.microsoft.com/api/mcp' })).toBe(
      'learn.microsoft.com/api/mcp'
    )
    expect(serverSummary({ transport: 'sse', url: 'http://localhost:3845/' })).toBe(
      'localhost:3845'
    )
  })
})
