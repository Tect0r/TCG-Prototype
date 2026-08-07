import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_FALLBACK_ART_URL, loadBundledCardData } from '@tcg/card-data';
import { CardArt } from './CardArt.js';
import { CardFrame } from './CardFrame.js';

const { database } = loadBundledCardData();

describe('CardArt fallback chain', () => {
  it('asks for the card art named after the card ID', () => {
    render(<CardArt cardId="goblin_scout" alt="art" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/card-art/goblin_scout.png');
  });

  it('falls back to the default image when the card art fails to load', () => {
    render(<CardArt cardId="missing_card" alt="art" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('img')).toHaveAttribute('src', DEFAULT_FALLBACK_ART_URL);
  });

  it('renders an empty art well rather than src="" when the default also fails', () => {
    const { container } = render(<CardArt cardId="missing_card" alt="art" />);
    fireEvent.error(screen.getByRole('img'));
    fireEvent.error(screen.getByRole('img'));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.card-art--empty')).not.toBeNull();
  });

  it('restarts the chain when the tile is handed a different card', () => {
    const { rerender } = render(<CardArt cardId="goblin_scout" alt="art" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('img')).toHaveAttribute('src', DEFAULT_FALLBACK_ART_URL);

    rerender(<CardArt cardId="bramble_titan" alt="art" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/card-art/bramble_titan.png');
  });
});

describe('CardFrame', () => {
  const card = database.getOrThrow('bramble_titan');

  it('renders every stat as live text, not baked into the image', () => {
    render(<CardFrame card={card} />);
    expect(screen.getByRole('heading', { name: 'Bramble Titan' })).toBeInTheDocument();
    expect(screen.getByLabelText('6 energy')).toHaveTextContent('6');
    expect(screen.getByLabelText('7 attack, 7 health')).toHaveTextContent('7/7');
    expect(screen.getByText('Unit — beast')).toBeInTheDocument();
    expect(screen.getByText('Armored')).toBeInTheDocument();
    expect(screen.getByText('Finisher · Major')).toBeInTheDocument();
  });

  // The frame's art is decorative (empty alt), so it is queried by element.
  it('stays fully readable after the artwork gives up entirely', () => {
    const { container } = render(<CardFrame card={card} />);
    const artImage = () => container.querySelector('img.card-art');

    expect(artImage()).toHaveAttribute('src', '/card-art/bramble_titan.png');
    fireEvent.error(artImage()!);
    expect(artImage()).toHaveAttribute('src', DEFAULT_FALLBACK_ART_URL);
    fireEvent.error(artImage()!);

    expect(artImage()).toBeNull();
    expect(container.querySelector('.card-art--empty')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Bramble Titan' })).toBeInTheDocument();
    expect(screen.getByLabelText('7 attack, 7 health')).toBeInTheDocument();
    expect(screen.getByText('Unit — beast')).toBeInTheDocument();
  });

  it('shows the copy count and the unique marker', () => {
    render(<CardFrame card={database.getOrThrow('overload_conduit')} copies={1} />);
    expect(screen.getByLabelText('1 in deck')).toHaveTextContent('×1');
    expect(screen.getByTitle('Unique — one copy per deck')).toBeInTheDocument();
  });

  it('shows a dash for cards with no energy cost', () => {
    render(<CardFrame card={database.getOrThrow('prototype_commander_blue')} />);
    expect(screen.getByLabelText('No energy cost')).toHaveTextContent('—');
  });
});
