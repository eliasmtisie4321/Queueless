import { StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { saveBasket } from '../../lib/basketStore.js'
import { hasPendingChanges } from '../../lib/basketSync.js'
import { useBasketSync } from '../useBasketSync.js'

// Logged in with Supabase set up; the account calls are faked so we can make them fail.
jest.mock('../../lib/supabase.js', () => ({ isDev: false, supabase: {} }))
jest.mock('../useAuth.js', () => ({ useAuth: () => ({ user: { id: 'u1' }, isLoggedIn: true, loading: false }) }))

const mockSync = jest.fn()
const mockSave = jest.fn()
jest.mock('../../lib/basketSync.js', () => {
  const real = jest.requireActual('../../lib/basketSync.js')
  return { ...real, syncOnLogIn: (...args) => mockSync(...args), saveBrowserBasket: (...args) => mockSave(...args) }
})

function Sync() {
  useBasketSync()
  return null
}

const offline = () => Promise.reject(new Error('Failed to fetch'))

beforeEach(() => {
  localStorage.clear()
  mockSync.mockReset()
  mockSave.mockReset()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

test('a failed first sync is retried when the browser comes back online', async () => {
  mockSync.mockImplementationOnce(offline).mockResolvedValue('b1')
  render(<Sync />)
  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1))

  await act(async () => window.dispatchEvent(new Event('online')))

  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(2))
})

test('a change made while the first sync failed is kept (pending) and retried', async () => {
  mockSync.mockImplementationOnce(offline).mockResolvedValue('b1')
  render(<Sync />)
  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1))

  act(() => saveBasket({ title: 'My basket', items: [{ productId: 'p1', quantity: 1 }] }))

  expect(hasPendingChanges()).toBe(true) // so the retry keeps this change instead of the account copy
  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(2))
})

test('a failed save is retried when the browser comes back online', async () => {
  mockSync.mockResolvedValue('b1')
  mockSave.mockImplementationOnce(() => {
    localStorage.setItem('queueless.basket.pending', '1') // what saveBrowserBasket does on failure
    return offline()
  }).mockResolvedValue('b1')
  render(<Sync />)
  await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1))

  act(() => saveBasket({ title: 'My basket', items: [{ productId: 'p1', quantity: 2 }] }))
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))

  await act(async () => window.dispatchEvent(new Event('online')))
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2))
  expect(mockSave).toHaveBeenLastCalledWith({}, 'u1', 'b1')
})

test('StrictMode (development) runs the effect twice, but the two syncs never overlap', async () => {
  let running = 0
  let most = 0
  mockSync.mockImplementation(async () => {
    running += 1
    most = Math.max(most, running)
    await new Promise((resolve) => setTimeout(resolve, 20))
    running -= 1
    return 'b1'
  })

  render(
    <StrictMode>
      <Sync />
    </StrictMode>,
  )

  await waitFor(() => expect(mockSync).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(most).toBe(1) // so only one of them can create the account basket
})
